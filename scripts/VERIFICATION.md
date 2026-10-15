# Mac 启动与备份验收

执行日期：2026-10-14。环境：macOS、Node.js 22.22.3、FFmpeg/ffprobe 8.1.1、SQLite 3.53.4。验收隔离使用 127.0.0.1:4320，未停止或接管 4318 的主验收实例。

| 检查 | 实际结果 |
| --- | --- |
| 首次双击脚本等价调用 | `启动.command` 完成 TypeScript strict 检查和 Vite 生产构建，API 与 Worker 健康状态通过 |
| 重复启动 | 相同端口/数据目录返回“复用现有进程”，没有启动第二个进程 |
| 页面可用 | GET `/` 返回生产前端，GET `/api/health` 返回 `ok:true`、`worker.online:true` |
| 日志 | `查看日志.command` 显示对应数据目录 `logs/server-4320.log` 的内容 |
| 正常停止 | `停止.command` 通过 PID 身份核验后停止实例，并保留 SQLite 与素材 |
| 中文、空格、引号路径 | 恢复数据目录 `data launcher 恢复 'QA'` 完成构建、启动、健康检查与停止 |
| 真实在线备份 | 运行中调用 `备份.command`，保存 SQLite 在线快照及 12 个素材的文件/缩略图，共 25 个校验文件 |
| 真实恢复 | CLI verify/restore 通过；新目录保留 1 个本地测试账号、12 个素材，原会话清空，SQLite integrity_check 为 ok |
| 恢复后启动 | 恢复目录启动后 API、Worker 与生产页面再次通过健康检查 |
| 构建错误处理 | 复评期间另一个源码变更触发 TS2367，脚本明确报告 build.log 并退出，没有虚报启动成功；该错误修复后重试通过 |
| 防误杀 | 自动测试写入指向无关真实 HTTP 服务的 PID 文件；停止不发终止信号，启动因端口占用退出，原服务始终可访问 |
| 备份密钥 | 自动测试验证默认不带主密钥、恢复后清空服务商密钥；加密备份不含明文主密钥，错误口令拒绝，正确口令恢复后可解密原凭证 |
| 恢复边界 | 自动测试验证拒绝覆盖现有数据、篡改文件导致校验失败、清单路径穿越被拒绝，未完成任务转为 needs_review |

专属验收测试：`npx vitest run scripts/launcher.test.ts scripts/backup.test.ts`，2 个测试文件、6 个用例通过。独立 TypeScript strict 检查及 `node --check scripts/launcher.mjs` 通过。

交付边界：用户需先安装 Node.js 与 FFmpeg；首次 npm 依赖安装需要网络。启动检查不会安装系统原生程序或更改系统安全设置。密钥备份需显式使用 `--with-secrets` 并保管独立口令。默认备份恢复后需要重新配置外部服务商，恢复操作不会自动重发历史外部任务。此验收不代表付费 AI 服务已真实联调。

验收产生的临时账号、数据目录与备份已清理；测试源码使用隔离临时目录，可重复运行。

## 主审Finder实际双击补验

2026-10-14 01:31–01:35（America/Los_Angeles），先用本项目脚本停止独立browser-qa实例，再通过Finder打开交付文件夹并真实双击`启动创作台.command`。默认`project/data`首次启动成功，API/Worker在线，浏览器显示独立本地账号首次设置页面。再次双击后PID仍为68020；双击`停止创作台.command`后状态为running:false/health:null；再双击启动成功。此处是实际原生Finder操作，不是shell等价调用。

[机器可读验收记录](../docs/evidence/ACCEPT-mac-launch.json)、[正式首次设置页面](../docs/evidence/ACCEPT-first-launch.jpg)。这台Mac的依赖已安装并核验；正式数据未创建测试用户。独立`data/browser-qa`保留复核资料，与前述脚本专项临时目录区分。服务当前运行，关闭启动终端不影响服务；双击停止文件可结束。
