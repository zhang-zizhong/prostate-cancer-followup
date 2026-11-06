# 安全策略

## 报告漏洞

请**不要**通过公开 Issue 报告安全漏洞。

- 使用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)（仓库 → Security → Report a vulnerability）
- 或在 Issue 中只说明「需要私下联系」，不要附细节

我们会在 7 天内确认收到，并在修复后致谢（如你愿意署名）。

## 支持范围

安全修复只针对 `main` 分支的最新代码。项目未发布正式版本号，不维护旧分支。

## 部署方必须知道的事

这是一个**单机部署的临床数据系统**，默认配置面向科室内网。直接暴露到公网前，请至少完成：

| 项 | 要求 |
|---|---|
| TLS | 必须，Nginx 终止 HTTPS，禁止明文 HTTP |
| `JWT_SECRET` | `openssl rand -hex 32`，不得使用示例值；泄露后立即轮换（所有会话失效） |
| `.env` 权限 | `chmod 600`，不得进入版本库 |
| `HOST` | 默认 `127.0.0.1`，只允许反向代理访问 |
| 管理员账号 | `INIT_ADMIN_USER` 不得为 `admin`；密码 ≥12 位；首登后立即改密 |
| 上传目录 | `uploads/` 不可被直接静态访问执行；限制扩展名与大小 |
| 备份 | `data/`、`uploads/` 定期冷备；备份文件含患者信息，必须加密存放 |
| 审计 | 定期检查 `audit_log` 的登录失败与批量导出记录 |
| 合规 | 按《个人信息保护法》《数据安全法》及本院伦理要求完成评估 |

### 已知的设计取舍（不是漏洞，但要知道）

- JWT 存在 `sessionStorage`，无 refresh token；XSS 可窃取当前会话。前端已避免 `innerHTML` 拼接不可信内容，但新增代码需自行保持。
- 没有 CSRF token：鉴权走 `Authorization` 头而非 Cookie，浏览器不会自动附带，因此 CSRF 风险较低；若改为 Cookie 鉴权，必须补 CSRF 防护。
- 没有登录失败锁定：建议在 Nginx 层加 `limit_req`。
- 没有字段级加密：SQLite 文件本身是明文，依赖磁盘加密与访问控制。
- AI 登记会把文本/图片发送给第三方模型服务；未配置 Key 时走离线模式，不联网。

## 患者数据

**永远不要**在 Issue、PR、日志或测试夹具中粘贴真实患者数据。

如果发现仓库历史中意外包含患者数据，请联系维护者做历史重写（`git filter-repo`）并强制推送，同时通知所有已克隆者。
