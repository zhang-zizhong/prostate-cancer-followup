# 架构说明

> 目标读者：想二次开发或部署本项目的人。本文描述的是**当前实现**，不是理想架构；取舍点会明确写出。

## 1. 总体形态

```
浏览器（原生 JS，无构建）
        │  HTTPS / JSON
        ▼
Nginx（TLS、静态资源、上传体积限制）
        │  HTTP 127.0.0.1:3000
        ▼
Node.js 单进程（Express 4，ESM）
        ├── SQLite（data/clinical.db，WAL）
        ├── uploads/（病历、报告、影像文件）
        └── 阿里云百炼（可选，AI 登记）
```

**单进程 + SQLite** 是刻意选择：科室内部部署，一台 2C4G 的服务器即可，零外部依赖、备份就是拷一个文件。代价是水平扩展和多中心协同需要改造数据层（见第 7 节）。

## 2. 目录与职责

| 位置 | 职责 |
|---|---|
| `server.js` | 入口。建表与迁移、鉴权中间件、全部 REST 路由、备份恢复、审计 |
| `lib/visit-rules.mjs` | 纯函数：访视/治疗段/化疗周期/不良事件的校验、分级、下次随访推算 |
| `lib/lab-catalog.mjs` | 检验项目字典、单位换算、别名归一 |
| `lib/guideline-catalog.mjs` | 指南知识库：4 张流程图、286 个节点、随访模板、合并症清单，通过 `GET /api/catalog` 下发 |
| `lib/ai-*.mjs` | AI 登记：提示词、模型调用、流水线编排、结果清洗 |
| `public/*-core.js` | 前端纯函数模块（临床判定、记录册、队列统计、导出），可在 Node 中单独测试 |
| `public/index.html` | 单页主界面：总览、患者列表、患者详情、数据管理、用户管理 |

前端没有打包器：`index.html` 直接 `<script src>` 加载各模块，模块通过 `window.XXX` 暴露接口，同时在文件尾部兼容 `module.exports`，以便 Node 侧用 `vm.runInNewContext` 做单元测试。这是「零构建」和「可测试」之间的折中。

## 3. 数据层

- SQLite，`journal_mode=WAL`、`foreign_keys=ON`（`server.js` 启动时设置）。
- 建表使用 `CREATE TABLE IF NOT EXISTS`，启动时执行增量 `ALTER TABLE` 迁移；**没有迁移框架**，新增列要自己写幂等判断。
- 核心表分四层：
  - **主档**：`patients`
  - **诊疗事件**：`psa_records`、`testosterone_records`、`pathology_reports`、`imaging_studies`、`radiation_records`、`surgery_records`、`lab_values`、`clinical_records`
  - **治疗与随访**：`treatment_episodes`、`treatment_lines`、`medication_records`、`medication_administrations`、`chemo_cycles`、`visits`、`visit_episode_rows`、`visit_items`、`adverse_events`、`disease_states`、`comorbidities`
  - **科研与治理**：`specimens`、`genomic_tests`、`ihc_results`、`patient_outcomes`、`file_assets`、`audit_log`、`users`

字段口径见 [data-dictionary.md](data-dictionary.md) 与 [data-dictionary-v13.md](data-dictionary-v13.md)。

**三态语义**贯穿全库：`NULL` = 未评估，`0` = 评估为否，`1` = 是。统计与导出都把 `NULL` 当「缺失」而不是「阴性」，这是本项目和普通 CRUD 最大的区别，改代码时务必保持。

**临床动作与时间轴的溯源**：手术、化疗周期、给药、不良事件四类「真正发生的动作」各自带 `event_id`，写入时镜像一条 `timeline_events` 记录，删除时同步清理。治疗线、用药区间、合并症、疾病状态等「状态型」数据不自动造节点，避免时间轴被状态变更刷屏。新增类似动作时，沿用 `upsertMirrorEvent` / `deleteMirrorEvent` 这一对函数，不要直接写 `timeline_events`。

## 4. 请求链路

1. **鉴权**：`POST /api/auth/login` 校验 bcrypt 哈希，签发 JWT（`Authorization: Bearer`）。前端存 `sessionStorage`，关闭标签页即失效；没有 refresh token。
2. **数据范围**：中间件解析 JWT 后，`admin` 可访问全部患者；`role='user'` 只能访问 `created_by` 为自己的患者。列表、详情、写入都要过这层，不要只在前端隐藏。
3. **校验**：写接口先过 `lib/visit-rules.mjs` 的纯函数校验，再落库；错误以 `{ error: '...' }` + 4xx 返回。
4. **审计**：登录、增删改、导出、备份恢复写 `audit_log`。
5. **备份**：`GET /api/backup/export` 导出全库 JSON（含版本号），`POST /api/backup/import` 仅管理员可调用。

## 5. AI 登记流水线

```
上传材料 → 落 uploads/ → 建会话（queued）
   → preprocessing（解析文本/图片清单）
   → redacting（可选，脱敏模型替换姓名/住院号/电话）
   → extracting（结构化抽取，JSON Schema 约束）
   → pending（等待医生审核）
   → adopted / rejected
```

要点：

- 状态机定义在 `lib/ai-intake.mjs` 的 `AI_STATUS`，失败进 `failed` 并记录 `error_class`。
- **未配置 `DASHSCOPE_API_KEY` 时走离线演练模式**：不联网，返回结构合法的示例结果，会话标记 `offline-mock`，界面显著提示，避免被误采信。
- 抽取结果**必须经医生逐条审核**才入库；系统不做自动入库。
- 有单会话 token 熔断（`AI_SESSION_TOKEN_BUDGET`）和并发上限（`AI_MAX_CONCURRENT`），防止脚本 bug 烧配额。
- 模型输出会过 `sanitizeWarnings()`，剔除与材料原文不符的告警，减少幻觉噪声。

## 6. 前端模块

| 文件 | 职责 | 测试 |
|---|---|---|
| `clinical-core.js` | BCR、CRPC、危险分层、PSA 动力学、疾病状态自动评估 | `test-clinical-logic.mjs` |
| `record-core.js` | 记录册：治疗段、访视行、访视项目、AE 分级 | `test-record-core.mjs` |
| `cohort-core.js` | 队列切片与统计 | `test-cohort-core.mjs` |
| `export-core.js` | tidy CSV 生成 + store-only ZIP 打包（无第三方库） | `test-export-core.mjs` |
| `ai-intake-ui.js` | AI 登记上传、轮询、审核、采纳 | `test-ai-intake-fixes.mjs` |

这些文件都是「无 DOM 依赖的纯逻辑」优先：能算的都放纯函数里，DOM 操作留在 `index.html`。

## 7. 已知限制

- **单机单进程**：不适合多中心并发写入；要扩展建议换 PostgreSQL + 对象存储，并把 `server.js` 的路由拆成 service 层。
- **`server.js` 是单体**：路由与业务逻辑混在一个文件里，修改时注意上下文。重构方向是按领域拆 `routes/` + `services/`。
- **无迁移框架**：表结构变更靠启动时的幂等 `ALTER`，回滚需要手工处理。
- **JWT 无刷新机制**：8 小时过期后需重新登录。
- **AI 抽取依赖第三方 API**：涉及患者数据出境/出院的合规问题，真实环境请先做脱敏与合规评估，或替换为本地模型。
- **未做临床验证**：所有判定规则（BCR、CRPC 等）仅按指南文本实现，未与真实队列做一致性验证。

## 8. 改动建议

1. 先跑 `npm test`，它是当前行为的基线。
2. 改判定规则时，同步改 `docs/data-dictionary*.md` 里的口径说明。
3. 新增字段：`CREATE TABLE` 处加列 + 启动迁移加 `ALTER` + 备份导入导出加字段 + 数据字典加说明，四处缺一不可。
4. 不要在前端做权限判断的唯一防线，服务端必须再校验一次。
