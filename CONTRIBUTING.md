# 参与贡献

感谢你愿意改进这个项目。它是从一间医院的真实随访工作里长出来的，最需要的贡献往往不是「更多功能」，而是**判定口径更准**和**部署更省事**。

## 先读这些

- [README.md](README.md)：项目定位与快速开始
- [docs/architecture.md](docs/architecture.md)：架构、已知限制、改动建议
- [docs/data-dictionary.md](docs/data-dictionary.md)：字段口径

## 开发环境

```bash
node -v            # 需要 >= 20
npm install
cp .env.example .env
# 填 JWT_SECRET 与 INIT_ADMIN_USER / INIT_ADMIN_PASS
npm start
```

`better-sqlite3` 是原生模块，换 Node 大版本后需要 `npm rebuild better-sqlite3`。

## 改动前

1. 跑一遍基线：`npm test`，确认全绿。
2. 涉及判定规则（BCR / CRPC / 危险分层 / AE 分级）的改动，请在 PR 里附**指南原文出处**（CSCO / NCCN / EAU 的章节号或页码）。
3. 涉及表结构的改动，四个地方要同步：建表、启动迁移、备份导入导出、数据字典。

## 提交规范

- 一个 PR 只做一件事；格式化改动请单独提交。
- 提交信息用中文或英文均可，建议 `类型: 简述`，例如：
  - `fix: CRPC 判定在睾酮缺失时不再默认成立`
  - `feat: 队列统计新增按危险分层切片`
  - `docs: 补充 v13 字段口径`
- 新增/修改逻辑请补测试，测试放在 `scripts/test-*.mjs`，用 `node:test` + `node:assert`。

## 绝对不能提交的内容

| 禁止 | 说明 |
|---|---|
| 真实患者数据 | 姓名、住院号、身份证、电话、影像、病理原文，一律不行 |
| `.env` / 密钥 | `JWT_SECRET`、`DASHSCOPE_API_KEY` 等 |
| 真实服务器地址 | IP、域名、SSH 配置、部署脚本中的生产参数 |
| 大型二进制 | 备份包、数据库文件、截图批次；单文件请控制在 1MB 内 |

提交前自查：

```bash
git status
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{16,}|([0-9]{1,3}\.){3}[0-9]{1,3}'
```

需要测试数据时，用 `python3 scripts/generate-test-cohort.py` 生成模拟队列。

## PR 检查清单

- [ ] `npm test` 通过
- [ ] 没有新增真实患者数据 / 密钥 / 服务器地址
- [ ] 新字段已同步数据字典
- [ ] 判定规则改动附了指南依据
- [ ] 前端改动在 1440px 与 390px 宽度下都看过

## 行为准则

就事论事，尊重同行。评审意见针对代码，不针对人。涉及临床判断的分歧，以指南原文和可复现的数据为准。

## 许可证

提交 PR 即表示你同意以 [Apache License 2.0](LICENSE) 授权你的贡献。
