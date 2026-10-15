# 候选架构（未定案）

状态：提案。必须在登录后的功能调查及规格评审后再定案，不能先按猜测实现。

## 方向
TypeScript strict 模块化单体 + 独立媒体 worker。

- apps/web：React，页面展示和交互。
- apps/api：长期运行 Node.js API，业务服务、认证授权、输入校验。
- apps/worker：持久化任务驱动的 FFmpeg 与第三方 AI 处理。
- packages/contracts：共享运行时请求/响应 schema 和错误码。
- packages/db：SQLite schema、版本迁移、事务、repository。
- packages/media：媒体校验、转码、产物检查。
- packages/providers：可配置且真实执行的模型供应商适配器。

SQLite 保存元数据、任务状态、关系与归属；文件系统保存受控存储键对应的真实素材和产物。
SQLite WAL、foreign_keys、busy_timeout 均需显式设置。写事务保持短小，不在事务内执行转码或网络请求。

## 数据与任务保证
- queued → running → succeeded / failed / cancelled。
- 领取租约、心跳、领取版本，完成提交时验证版本，避免过期 worker 覆盖新结果。
- 重试次数及下一次执行时间持久化；外部生成保存 provider task ID。
- 至少一次执行配合幂等，不承诺不可验证的 exactly-once。
- 临时产物通过 ffprobe 校验后原子移动，成功状态必须有可读取的产物支撑。
- 进程重启恢复过期任务，取消与完成竞争必须通过测试。

## 安全与边界
- 上传检查实际格式、体积、时长、分辨率；文件放 webroot 外。
- 文件与所有数据 API 检查 owner/workspace 归属，不仅在菜单隐藏入口。
- 外部 URL 防 SSRF；FFmpeg 使用参数数组，禁止 shell 字符串拼接。
- 配置密钥只在服务端，未配置能力明确显示依赖，不能输出假成功。
- 备份包含一致数据库快照和素材清单；最终测试从空目录恢复。

## 运行环境发现
- Node.js 22.22.3；npm 10.9.8；FFmpeg 8.1.1。
- Python sqlite3 当前 SQLite 3.50.4，不直接选作多进程 WAL 数据层。
- 实际采用的数据库驱动需在安装后验证 SELECT sqlite_version()，包含官方 WAL-reset 修复。
- npm registry 查询候选：better-sqlite3 13.0.3（Node >=22）、Fastify 5.12.7、Vite 8.3.4；尚未安装、锁定或作为最终栈。

## 待调查后决定
时间线模型、模板与编辑器、字幕/配音关系、批量生成、共享权限、额度、删除策略、导出规格、服务商清单。

## 依据
- https://www.sqlite.org/wal.html
- https://www.sqlite.org/wal.html#walreset
- https://www.sqlite.org/foreignkeys.html
- https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- https://ffmpeg.org/ffmpeg-protocols.html
