# Crosscut 跨境创作台

在 Mac 本地运行的跨境广告创作应用。SQLite、素材和日志默认保存在本项目 `data` 目录；网页只监听本机 `127.0.0.1`。界面和业务代码自主实现，原站观察记录与功能边界见 [docs](docs/00-delivery-plan.md)。

## 双击启动

下载或克隆仓库后，在仓库根目录直接双击 [启动创作台.command](启动创作台.command)；停止使用同目录的 [停止创作台.command](停止创作台.command)。这两个便捷入口会调用同目录的启停脚本，不会建立第二套数据库。项目可以放在任意文件夹，无需使用原作者的电脑路径。

原交付环境已实测 Node.js（运行环境）22.22.3 与 FFmpeg（媒体处理工具）8.1.1。新电脑请先检查并准备以下依赖。Finder（访达）双击启停、重复启动与恢复的历史验收记录见 [Mac验收](scripts/VERIFICATION.md)。

1. 安装 **Node.js 22.22 或更高版本**及 **FFmpeg / ffprobe 8+**。Node 安装包来自 [nodejs.org](https://nodejs.org/)。已使用 Homebrew 的 Mac 可运行 `brew install node@22 ffmpeg`。SQLite 已随项目依赖提供，无需另装数据库服务器。
2. 双击项目根目录的 **启动.command**。首次启动会按 `package-lock.json` 准备依赖、检查 TypeScript、构建界面，随后打开 [本地应用](http://127.0.0.1:4318)。第一次安装 npm 依赖需要网络；日志会显示实际进度。
3. 首次进入请创建本地账号。这个账号独立于参考平台；项目没有内置参考平台密码或默认管理员密码。

`启动.command` 可以重复运行，会核验已有进程并复用它。关闭启动终端不会停止服务。需要停止时双击 **停止.command**；需要排查问题时双击 **查看日志.command**。脚本不会使用 `killall` 或终止占用同一端口的其他服务。

## 能力与配置

- 本地 FFmpeg 功能可直接运行：真实批量混剪、画幅/格式转换、时间裁切、图片成片、用户字幕烧录、明确区域遮挡/裁切、技术分镜和关键帧提取。
- AI 图像、视频、配音、转写、数字人、声音克隆、语义分析等需要在设置中配置**自己的服务商账号、密钥、模型及对应能力**。设置某个聊天端点不会自动获得全部媒体能力。缺配置或不支持的能力会明确报错并保留输入。
- 调用外部 AI 会向所选服务商发送该次任务需要的文字或媒体。项目本地存储不表示全部模型在本机推理。
- “本地字幕遮挡/裁切”会改变画面，不能视为无痕修复；本地分镜检测基于画面差异，不会推断营销效果；混剪字幕使用用户原文，不自动翻译。
- 不提供原站私有素材库、内部算法、商业积分支付系统或其账号访问。原站展示名与真实供应商 API 模型 ID 分开处理。

配置步骤、官方服务地址和自定义工作流契约见 [服务商配置与外部工作流接入](docs/06-provider-setup.md)。`workflow-http-v1` 是外接服务协议；项目没有内置手持商品、爆款复刻、链接成片或智能字幕修复引擎，需要另外提供真正实现相应能力的兼容服务。

逐项可用能力与差距见 [9 个入口 / 17 个工具功能对照](docs/05-coverage-matrix.md)，协议依据见 [AI 适配契约研究](docs/adr/provider-contracts-research.md)。离线协议测试通过不等于已完成付费模型真实联调；没有用户独立服务凭据时，不会把外部AI标成真实推理通过。

## 备份与恢复

双击 **备份.command**。备份保存到 `backups/` 下的独立时间目录，使用 SQLite 一致性备份 API，包含快照数据库、它引用的全部素材及缩略图、SHA-256 清单。可以在应用运行时备份；不会只复制处于 WAL 写入中的主数据库文件。

**默认备份不导出主密钥。** 恢复后仍能读取项目、素材、历史和账号，服务商密钥需要重新配置。旧外部任务的加密快照不能直接恢复执行，应复用参数新建任务。备份仍含个人业务数据，应保管在可信位置。

如果需要同时恢复服务商密钥，可以显式创建带加密主密钥的备份：

```bash
cd "/你的项目路径/crosscut-studio"
node --import tsx scripts/backup.ts create --with-secrets
```

终端会要求输入独立的备份口令，至少 12 个字符且不回显。主密钥使用 scrypt + AES-256-GCM 加密，备份中不写明文主密钥；请另行保管口令。口令遗失无法解密该密钥备份。

校验备份和恢复到**全新或空目录**：

```bash
node --import tsx scripts/backup.ts verify "/完整路径/备份目录"
node --import tsx scripts/backup.ts restore "/完整路径/备份目录" --to "/完整路径/恢复数据"
```

恢复拒绝覆盖已有数据，先校验每个文件、SQLite 完整性和素材引用，再发布恢复目录。有加密主密钥时需要原口令。恢复会失效全部登录会话，将排队/运行中的任务设为“待核对”，避免自动重复调用产生费用。历史完成产物保留。

使用恢复数据前，先停止现有服务，再在终端启动：

```bash
CROSSCUT_DATA_DIR="/完整路径/恢复数据" ./启动.command
```

随后停止也应使用同一个数据目录：

```bash
CROSSCUT_DATA_DIR="/完整路径/恢复数据" ./停止.command
```

## 路径、环境变量与故障定位

项目支持中文、空格和引号路径；脚本按自身所在目录解析项目，不依赖 Finder 打开时的工作目录。

| 变量 | 默认值与用途 |
| --- | --- |
| `CROSSCUT_DATA_DIR` | 项目下 `data`；可以指定独立数据目录，启动/停止/日志/备份时保持一致 |
| `CROSSCUT_PORT` | `4318`；只绑定 `127.0.0.1`，改端口时启动与停止保持一致 |
| `CROSSCUT_NO_OPEN=1` | 启动后不自动打开浏览器，便于自动化验收 |
| `CROSSCUT_NONINTERACTIVE=1` | `.command` 脚本结束时不等待回车 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 自定义媒体程序路径；默认从 PATH 查找 |
| `CROSSCUT_FONT_PATH` | 自定义中文字体文件；Mac 默认使用系统 Arial Unicode 字体 |
| `CROSSCUT_BACKUP_PASSWORD` | 仅用于自动化备份/恢复的口令环境变量；日常使用推荐终端隐式输入，不放入命令参数或源码 |

状态检查：`node scripts/launcher.mjs status`。日志位于所选数据目录的 `logs/server-端口.log`；依赖安装和构建日志分别为 `install.log`、`build.log`。启动失败会显示确切日志路径，不会显示虚假的“启动成功”。

- 缺少 Node/FFmpeg：按提示安装或设置路径后重启；脚本不会修改系统安全设置或静默下载原生可执行文件。
- 端口被其他程序占用：换用 `CROSSCUT_PORT`，或由你自己管理那个程序；本项目不会接管它。
- 构建报错：保留 `build.log`，修复列出的 TypeScript/依赖错误后重新启动。
- Worker 不在线：先停止再启动，检查运行日志。未完成任务会根据实际状态恢复或要求核对。
- 缺中文字体：设置 `CROSSCUT_FONT_PATH`。字幕通过字体栅格化和 FFmpeg 叠加实现，不要求 FFmpeg 含 libass。

## 开发与验收

技术栈：TypeScript strict、React + Vite、Fastify、better-sqlite3、独立 Node Worker、FFmpeg / ffprobe。业务数据使用 SQLite WAL，密钥由本地 0600 主密钥加密。

```bash
npm ci
npm run check
```

前端开发可用 `npm run dev`，后端可用 `npm start`；完整本地运行推荐启动脚本，因为它会管理依赖、构建、端口与进程身份。测试使用隔离数据库、真实生成的测试媒体或离线服务商 fixture，不会自动消耗你的付费模型额度。

`npm run check` 依次运行类型检查、格式检查、自动化测试与生产构建；也可分别使用 `npm run typecheck`、`npm run format:check`、`npm test`、`npm run build`。最终统一执行已通过：14个测试文件、156个用例，类型检查、格式检查与生产构建通过，见 [检查日志](docs/evidence/check-final.txt)。测试通过范围包含真实本地媒体和受控外部协议，不包含真实AI推理。

本地验收已形成可复核交付，**完整复刻要求尚未全部满足**；本轮结果、截图、A01–A18和剩余门槛见 [验收报告](docs/07-acceptance.md)。阶段复评见 [实现阶段审查](docs/reviews/05-implementation-review.md) 与 [质量门槛](docs/reviews/quality-gates.md)。需求、调查事实、设计决策和阶段审查分别位于 `docs/`、`docs/evidence/`、`docs/adr/`、`docs/reviews/`。最终是否达到各项功能要求应以逐项验收及真实证据为准，不能仅凭入口存在或协议测试通过判断。

公开版本不包含原站调查截图、本地账号、数据库、素材库、密钥、日志或备份；保留源码、文字观察记录、本地演示截图及原创示例成片。公开范围与历史验收记录的脱敏说明见 [公开发布说明](docs/public-release.md)。
