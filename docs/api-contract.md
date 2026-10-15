# 实现共享接口（开发协作）

API 同源 /api，JSON，错误 `{error:{code,message,details?}}`；所有成功对象JSON直返，无data包装。普通列表使用 `{items:[...],total:number}`，批次操作和部分上传的例外见下。共享类型 src/shared/types.ts。
除 status/setup/login/health，其余需cookie登录。写操作自动同源 Origin 校验。浏览器fetch带credentials same-origin。

- GET /health → `{app:'crosscut',ok:true,version,worker,sqliteVersion}`
- GET /auth/status → `{initialized:boolean,user:User|null}`
- POST /auth/setup `{email,name,password}` → `{user}`（仅空库）；POST /auth/login `{email,password}` → `{user}`；POST /auth/logout → `{ok:true}`
- GET /me → User；PATCH /me `{name,profile}` → User
- POST /me/password `{currentPassword,newPassword}` → `{ok:true}`；需验证旧密码，撤销已有会话并通过响应cookie签发当前新会话。新密码10–200字符。
- GET /overview → `{projects:number,assets:number,jobs:number,completed:number,recentJobs:Job[],recentProjects:Project[],capabilities:{local:number,configured:number,total:number},storageBytes:number}`
- GET /tools → `{items:Tool[],total}`（字段和availability由服务端共享catalog提供）
- GET /projects?search=&archived=0 → 列表；POST /projects `{name,description?,market?,brand?}`；PATCH /projects/:id 同字段+`archived:boolean`
- GET /assets?search=&kind=&trash=0&projectId= → 列表；POST /assets multipart files → `{items:Asset[],total:number}`；PATCH /assets/:id `{name?,tags?,deleted?:boolean}` → Asset；GET /assets/:id/file?download=1 → 真实文件，支持单段Range；GET /assets/:id/thumbnail → 缩略图；POST /assets/demo → 添加本项目生成的明确示例素材（不假称用户生成）。
- POST /assets 逐文件保存，遇到首个失败停止后续处理。如果已有文件保存成功，返回非2xx错误 `error.code='PARTIAL_UPLOAD'`，`error.details.items:Asset[]` 列出已保存项；这些文件已持久化并可立即预览/下载。客户端应保留这些结果并刷新素材列表，不应把整批当未保存而全部自动重传。若尚无成功项，返回原始错误。单文件250MB上限；任务另有素材合计1GB及逐工具限制。
- GET /drafts?trash=0 → 活跃草稿列表，`trash=1`返回回收站；POST /drafts `{id?,title,toolId,projectId?,input}` → Draft（提供已有id时完整更新并恢复）；PATCH /drafts/:id `{deleted:boolean}` → `{ok:true}`（恢复或软删除）；DELETE /drafts/:id → `{ok:true}`（软删除）。恢复保留原项目、工具及输入，所有操作均校验所有者。
- POST /jobs `{toolId,title?,projectId?,input,providerId?,idempotencyKey}` → `{items:Job[],batchId}`；input.count控制输出数量，独立子任务。相同key不同输入409。
- GET /jobs?search=&status=&toolId=&projectId=&limit=50&offset=0 → 列表；GET /jobs/:id → Job含events；POST /jobs/:id/cancel → Job；POST /jobs/:id/retry → Job；GET /jobs/:id/download → zip产物。
- GET /batches/:id → `{id,total,counts:{queued,running,succeeded,failed,cancelled,needs_review},outputCount}`；counts各值为数量，outputCount仅统计成功子任务的输出数。
- POST /batches/:id/cancel → `{items:Job[],errors:{id,message}[]}`；只尝试处理当前排队/运行中的子任务。已结束项保持原状；一项失败不会回滚其他项。
- POST /batches/:id/retry → 同上；只尝试重试`failed`子任务，跳过成功、取消、运行中和待核对项。远端终态或提交结果不明仍被逐项保护，错误进入errors。`items`是本次成功处理的项，不是批次所有任务；HTTP 200不代表没有逐项错误。
- GET /batches/:id/download → ZIP，仅包含成功子任务产物和`batch-status.json`状态清单；没有成功产物返回404 `NO_OUTPUT`。批次状态、操作和下载均校验批次所有者。
- GET /providers → 列表ProviderPublic；POST /providers `{id?,name,kind,baseUrl,model,models?,capabilities:string[],apiKey?:string,voices?:[],avatars?:[]}` → ProviderPublic；同类型、同URL源编辑时空apiKey保留旧密钥，类型或源改变必须重输密钥，否则400 `REENTER_API_KEY`。保存不发起推理，重置能力验证标记；DELETE /providers/:id 禁用，现有任务快照保留。返回配置状态及`verifiedCapabilities`，绝不返回密钥。
- GET /settings/runtime → `{node,ffmpeg,ffprobe,sqliteVersion,dataDir,worker,storageBytes}`；GET /usage → `{items:[],total}`实际任务调用记录。
- GET /radar?search=&country=&industry=&objective=&format=&favorite=1&sort=likes&order=desc → 列表；POST /radar 单条RadarAsset输入（ID/createdAt/favorite由服务端）；POST /radar/import `{items:[...]}`批量导入；POST /radar/:id/favorite `{favorite:boolean}` → RadarAsset。
- POST /product/inspect `{url}` → `{title,description,price,imageUrls,sourceUrl}`仅解析公开HTML，不执行脚本，不自动下载图片；抓取失败允许手动填写。
- GET /conversations?trash=0 → 列表；POST /conversations `{title?}` → Conversation；GET /conversations/:id → Conversation带`messages[].jobId`与`jobs:Job[]`（包含所有批次子任务）；PATCH /conversations/:id `{title?,deleted?}`只更新显式字段。
- POST /conversations/:id/messages `{content,providerId?,idempotencyKey?}` → Job。只有同对话未完成的聊天任务阻止新聊天（409 `CONVERSATION_BUSY`）；重放同提交键返回原任务，不重复用户消息；不同输入复用键返回409。兼容未带键的旧客户端，但新客户端必须保留失败请求的键。
- POST /conversations/:id/creations `{toolId:'video-studio'|'replication',title?,input,providerId?,projectId?,idempotencyKey}` → `{items:Job[],batchId}`。这是用户确认参数后的明确创作提交；不代表模型自动决策。键按对话及操作命名空间隔离；对话归属、回收状态、幂等检查与建任务/消息在同一立即事务内完成。缺少服务时不写任务或提交消息；每项真实完成产物会关联到对话。两接口的键最多100字符，收费操作及外部依赖遵守通用任务规则。
- POST /analyses `{assetId,providerId?,mode:'semantic'|'technical'}` → `{id,version,jobs:Job[]}`；GET /analyses → 列表；GET /analyses/:id → `{id,assetId,versions:[{version,jobs:Job[],prompt:string}],createdAt}`；POST /analyses/:id/retry `{section?:'timeline'|'mechanism'|'prompt',providerId?}` 新版本；PATCH /analyses/:id/prompt `{version,prompt}`。
- 分析新版本保留历史版本；单节重跑复用其他节的任务。生成过程中修改提示词后，迟到模型结果保留在任务result中，只有版本提示词仍等于创建时基线才自动更新编辑框，避免覆盖人工编辑。
- GET /analyses 支持`search,source=upload|generated|demo,mode=technical|semantic,status,from,before,order=newest|oldest,limit=1..100,offset`。返回`{items:[{id,assetId,assetName,source,createdAt,version,mode,status,taskCount,completed}],total}`；只聚合最新版本，不携带全部历史分析结果。`status`还支持`partial`。`from/before`必须是带时区ISO时间，前含后不含，起点不能晚于或等于终点。
- 分镜/机制结果v2由`shared/analysis.ts`校验，包含阶段/镜头/景别/视角/动作/屏幕文字/翻译，机制目标/证据/原理/问题/行动/预期收益。未知字段保留null，时间码须在真实视频时长内，阶段与镜头顺序和包含关系必须合法。兼容旧v1结果；结构正确不代表语义准确。
- GET /assets 支持`search`（名称/标签/ID字面匹配）、`tags`（JSON字符串数组，标签并集）、`from/before`、`sort`、`trash`。GET /radar 另支持`industryPaths`（JSON路径数组，选择父路径包含下级）、`tags`（关联素材的标签）、`from/before`、`sort=favorite_at`。旧`industry`参数继续支持；目录筛选数据只来自当前用户真实记录。日期表示本地添加日期；收藏时间取`favorites.created_at`，重复收藏不会重置。

## 任务状态、取消和恢复

- 状态为`queued/running/succeeded/failed/cancelled/needs_review`。创建每个子任务时持久化输入、素材关联和服务配置快照；批次数量不代表一个供应商请求生成多条。
- 本地未提交任务可取消。收费提交占位与取消采用条件更新，取消先成功则不调用外部服务；供应商提交先成功则返回409 `SUBMISSION_IN_PROGRESS`，等待任务编号和状态更新。
- 已有远端任务ID时调用专用取消接口。只有服务确认取消才标`cancelled`；仅接受取消请求时`cancelRequested=true`并继续查状态；不支持则409 `REMOTE_CANCEL_UNSUPPORTED`。完成状态不会被迟到的取消响应改写。
- 单任务retry接受普通`failed/cancelled`，但远端已失败/过期/取消的任务不能重新查询冒充新生成，需要从原参数创建新的收费任务。200个活跃任务为单用户队列上限。
- `SUBMISSION_UNKNOWN`进入`needs_review`；同步收费服务收到成功响应、但解析/下载/媒体校验/后处理失败时使用`RESULT_PROCESSING_FAILED`；适配器已返回结果、但本地保存或终态事务失败时使用`RESULT_COMMIT_FAILED`。这三类均禁止自动或普通retry重发，返回409 `REVIEW_REQUIRED`。首次请求明确的400/401/429等拒绝仍为普通失败，修正后可retry；无远端ID的普通重试会清除提交占位。
- 异步任务恢复使用已保存的远端ID，不再次创建。Worker租约丢失后不能提交成功；输出关联、任务成功、调用记录和对话结果在同一立即事务内提交。失败时回滚产物关联并清理未提交的产物。

工具所有输入值是 ToolInput；assets字段为字符串ID数组，不发送本地路径。常用键：sourceIds（主要文件）、imageIds、audioIds、videoIds；prompt、text、script、productName、sellingPoints、description、price、currency、url、language、voice、avatar、duration、ratio、resolution、format、count、subtitles、subtitleText、subtitleStyle、speed、volume、start、end、mode、quality、region、audience、scene、direction。以共享catalog的逐工具schema为准，不应把其他工具参数或任务内部恢复字段原样提交给新建接口。33个字幕样式来自共享subtitle-styles，`none`只在声明支持的表单使用。
provider为空的本地工具可运行；缺外部配置API 503，UI应保留表单并链接设置。任务输入快照与产物都来自API，不能造假进度和样片。

## 参数与目录边界

`shared/provider-limits.ts`定义已实现接入方式的参数交集，创建任务及真正调用前都检查；已有远端ID的恢复优先查询，避免因新增规则丢失已付费任务。音色/角色必须来自所选服务的已登记目录，允许的OpenAI内置音色例外；登记不代表实际授权。复刻跟随时长使用已探测参考视频的4–60秒时长；混剪推荐时长明确解析为固定30秒。工作流进度作为`workflow-game`/`workflow-commerce`版本化草稿保存，刷新后恢复步骤、表单、素材来源、已提交任务和产物关联，不从UI步骤推断任务成功。
