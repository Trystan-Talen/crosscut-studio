# AI 服务适配契约研究

研究日期：2026-10-13（America/Los_Angeles）
状态：接口文档研究及本地适配器实现完成；尚未接入任何真实账户或执行付费请求。实现状态与已知边界见第 11 节。
关联证据：`docs/01-scope.md`、`docs/evidence/OBS-creative.md`。本文的架构规则是本项目设计决策；供应商事实附官方出处。

## 1. 决策摘要

采用逐能力适配，最小集合为 `chat`、`image.generate`、`image.edit`、`speech`、`transcription`、`video.task`。OpenAI 风格聊天成功不证明图片、音频或视频接口可用。第三方所说的“OpenAI-compatible”没有替代逐端点契约验证的效力。

最小真实链路的接入目标包括：脚本/提示词生成、图片生成、配音、转写，以及 Seedance 异步视频生成。第 9–10 节补充 ElevenLabs 音色克隆与 HeyGen 数字人/视频翻译的专用接口；目前适配器已实现并完成本机协议测试，真实服务联调仍待账户配置。字幕擦除、广告数据雷达、带货手持产品及完整复刻工作流需要独立实现，不能映射到一个聊天请求后宣称完成。

原站模型展示名与独立服务商模型 ID 分开保存。`Seedance 2.0-lite`、`MiniMax-H3` 等观察到的标签不能自动转换为猜测的 API ID；仅从当前服务商文档或账户配置注册实际模型。

## 2. OpenAI 风格基础接口

以下是 OpenAI 官方端点的最小形状，不是所有兼容网关的保证。官方基址为 `https://api.openai.com/v1`，服务端通过 `Authorization: Bearer <key>` 鉴权。配置中的基址包含版本前缀；拼接时不得丢失 `/v1` 或重复添加它。不要把密钥放在 URL、浏览器请求或日志中。[OpenAI API 认证](https://developers.openai.com/api/reference/overview#authentication)

以下 JSON 均为契约形状示例，尖括号代表配置值或示意值，不是真实调用结果。

### 2.1 Chat Completions

`POST /chat/completions`，JSON：

```json
{
  "model": "<configured-chat-model-id>",
  "messages": [{ "role": "user", "content": "为这款产品撰写一段英文广告脚本。" }],
  "stream": false
}
```

最小读取字段：`id`、`model`、`choices[].message.content`、`choices[].finish_reason`、可选 `usage`。必须同时处理空结果、`refusal`、截断以及 tool-call 返回，不能假定每个 200 响应都有非空文本。图像理解使用支持视觉的模型与 `messages[].content` 中的 `image_url` 内容块；图片 URL 或 Base64 内容由该端点支持。原始视频输入不是此最小契约的保证。[Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

本项目决定：先实现非流式返回，形成稳定契约后再加 SSE；`temperature`、结构化输出、token 上限等按具体模型能力发送，不能对所有模型盲目套用。真正的视频理解需要明确的抽帧/音轨流程与证据时间点，不能只根据文件名编造拆解。OpenAI 官方新项目建议考虑 Responses；本层保留 Chat Completions 是为了显式的兼容适配需求。

### 2.2 生图与图片编辑

`POST /images/generations`，JSON：

```json
{
  "model": "<configured-image-model-id>",
  "prompt": "为一款旅行水杯制作白色背景产品图。",
  "n": 1,
  "output_format": "png"
}
```

响应读取 `data[].b64_json`、`output_format`、可选 `usage`。当前 GPT Image 返回 Base64；不要为它发送旧的 `response_format: "url"` 或假定有 URL。尺寸、质量及透明背景选项按模型验证。兼容网关若返回 `data[].url`，需由它自己的 profile 显式启用并通过安全下载验证。[Create image](https://developers.openai.com/api/reference/resources/images/methods/generate)

参考图片编辑是另一项能力：`POST /images/edits`，可以使用 multipart `model`、`prompt`、`image[]` 文件字段，结果仍读图片数组。不能把用户参考图丢弃后改调用纯文本生图。[Create image edit](https://developers.openai.com/api/reference/resources/images/methods/edit)

本项目决定：将 Base64 解码并校验真实图片后保存为素材；API 不把大段 Base64 转发给前端，也不在日志打印。图片尺寸由解码所得实际尺寸记录。

### 2.3 配音

`POST /audio/speech`，JSON：

```json
{
  "model": "<configured-speech-model-id>",
  "input": "Discover your next everyday essential.",
  "voice": "<configured-supported-voice>",
  "response_format": "mp3"
}
```

正常非 SSE 响应为音频内容，必须按二进制处理，不能无条件 `response.json()`。官方输入上限为 4096 字符；输出格式包括 mp3、opus、aac、flac、wav、pcm；`speed` 范围为 0.25–4.0。`instructions` 和流式选项有模型差异。[Create speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)

本项目决定：默认 mp3，经媒体探测确认音轨与时长后成功。内置音色 ID 与定制音色 ID 分开，配音端点存在不能证明账户具备音色克隆权限，也不能把一个普通音频上传自动视为已创建声音身份。

### 2.4 转写与字幕

`POST /audio/transcriptions`，multipart：`file` 是实际文件内容，另有 `model`，可选 `language`、`response_format` 等。普通 JSON 结果读取 `text`；带时间轴或说话人信息的结构依模型和格式而异。`gpt-4o-transcribe` 与 `gpt-4o-mini-transcribe` 当前只支持 JSON；不能给它们统一发送 `srt` 或 `verbose_json`。[Create transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)

文件上限 25 MB。需要词/片段时间轴时，官方当前指导使用 `whisper-1`、`response_format=verbose_json`、`timestamp_granularities[]=word` 或 `segment`。超限音轨须压缩或按语句分段，并把偏移量带回全局时间轴。[File transcription](https://developers.openai.com/api/docs/guides/speech-to-text)

本项目决定：字幕功能必须获得时间戳或另做对齐。不得把纯文本按总时长等分后声称获得真实识别时间轴。表单支持的文件大小与 provider 单次上传上限分开；multipart boundary 交给 HTTP 库生成。

## 3. Seedance：火山方舟与 BytePlus

### 3.1 地域与端点

| 服务 | 独立基址 | 文档来源 |
| --- | --- | --- |
| 火山方舟，北京 | `https://ark.cn-beijing.volces.com/api/v3` | [视频生成教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh) |
| BytePlus ModelArk，ap-southeast | `https://ark.ap-southeast.bytepluses.com/api/v3` | [视频生成教程](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/video-generation-tutorial) |

两条服务配置分别保存，不共享默认模型 ID。它们的公开样例使用 Bearer API Key；API 可用性还取决于模型开通、账户权限、地区及额度。本文没有验证该用户在任何服务上的资格或余额。

| 操作 | 相对路径 | 处理规则 |
| --- | --- | --- |
| 创建 | `POST /contents/generations/tasks` | 接收任务 ID，立即持久化；不是视频成品 |
| 查询 | `GET /contents/generations/tasks/{id}` | 读取 provider 状态；成功后下载 `content.video_url` |
| 取消/删除 | `DELETE /contents/generations/tasks/{id}` | 操作语义依当前状态，详见下文 |

这些是 Seedance 服务自己的任务协议，不是 `/chat/completions`。任务创建后可轮询，或部署公开接收端处理 Webhook；本机首版建议持久化轮询，避免为了回调擅自公开服务。[方舟教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh)、[BytePlus 教程](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/video-generation-tutorial)

### 3.2 最小请求

以下为 BytePlus 文生视频的请求形状，模型 ID 为已在官方查询示例中确认的 2.0 ID；是否对用户账户开放尚未测试：

```json
{
  "model": "dreamina-seedance-2-0-260128",
  "content": [{ "type": "text", "text": "产品水杯放在桌面上，镜头缓慢靠近。" }],
  "duration": 5,
  "ratio": "9:16",
  "resolution": "720p",
  "generate_audio": false,
  "return_last_frame": true
}
```

创建响应的关键字段是 `id`。查询响应核心包括 `id`、`model`、`status`、`content.video_url`、可选 `content.last_frame_url`、`error.code/message`、`usage`。URL 有效期为 24 小时；查询记录保留窗口为最近 7 天。`expired` 也是需处理的终态，尽管查询页的简短 status 清单未完整列出它。[BytePlus 查询任务](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/get-video-generation-task-api)

方舟的 2.0 ID 为 `doubao-seedance-2-0-260128`。官方当前模型表还列出 2.5、2.0 fast、2.0 mini，但不据此证明原站的 lite 等标签存在同名官方 API。2.0 为 4–15 秒，2.5 为 4–30 秒；具体输出、格式和模型的组合不得跨模型套用。[方舟模型表](https://docs.volcengine.com/docs/ark/model-list?lang=en)

本项目决定：将每个 batch 子任务单独持久化 provider task ID；UI 的批量 1–4 条由本地编排，不能凭空发送未记录的 `n` 参数。`succeeded` 仅表示供应商生成完成；本地产物下载、校验和入库结束后，才将用户任务标为成功。

### 3.3 本地图片与参考模式

**方舟和 BytePlus 官方文档均明确支持本地图片转 data URL**，位置是 `content[].image_url.url`：

```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,<encoded-local-image>" },
  "role": "first_frame"
}
```

图片格式名须小写；单图小于 30 MB，JSON 请求体不超过 64 MB。图片边长范围 300–6000 px，宽高比 0.4–2.5。Base64 膨胀计入请求体预算，不能把原始文件 64 MB 当作安全阈值。首帧、首尾帧、全模态参考是互斥场景；对应角色为 `first_frame`、`last_frame`、`reference_image`。不得在同一请求随意混合模式。[方舟创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[BytePlus 创建任务](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api)

BytePlus 的当前文档给 `video_url.url` 的来源是公网 URL 或素材 ID，不能据图片支持 Base64 推断视频也支持 data URL。音频来源有 URL/Base64/素材 ID；Seedance 2.0 的音频参考需配合图片或视频。真实人脸参考另有 provider 的授权素材流程；一个本地图片上传不代表该调用一定被接受。[BytePlus 创建任务](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api)

本项目决定：小图可以由服务端编码提交，禁止日志打印 data URL。远端 provider 无法读取本机 `/uploads/...`、`file://...` 或浏览器 `blob:` 地址。需要公网视频时必须另配受控对象存储/可验证素材服务；当前没有这种配置就显示该输入方式不可用，不能上传前假装支持。

最小 2.0 profile 先开放已确认的 4–15 秒、480p/720p、文生/首帧/首尾帧；多参考、额外分辨率和其他模型可在完整输入限制校验及契约测试后开放。这是本项目实施顺序，不代表供应商只支持这些能力。

### 3.4 取消不是中止所有任务

| 供应商当前状态 | DELETE 语义 | 本地 UI 行为 |
| --- | --- | --- |
| queued | 取消排队并转 cancelled | 可请求取消，再同步最终状态 |
| running | 不支持 | 显示“服务商处理中，当前无法取消”；不假报取消成功 |
| succeeded / failed / expired | 删除远端任务记录 | 与取消按钮分开；不能为清理本地列表顺便删远端记录 |
| cancelled | 不支持再次删除 | 仅同步状态 |

该差异由双方官方取消/删除文档确认；BytePlus 响应示例是空对象，没有生成结果可读。[方舟取消或删除](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api)、[BytePlus 取消或删除](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/cancel-or-delete-video-generation-tasks-api)

本项目决定：对外部 running 任务，停止本地轮询不等于远端取消，也不能宣称停止计费。取消请求与服务端开始执行存在竞争，失败时继续查询并保留真实远端状态。

## 4. 本项目自有 Workflow HTTP 协议

命名为 `workflow-http-v1`，明确标注“本项目自定义协议”。它不是 OpenAI、Seedance、ComfyUI、n8n 或任意服务商的行业标准，不保证把一个 URL 填入就能驱动所有工作流。

候选最小协议：

| 操作 | 路径 | 自有约定 |
| --- | --- | --- |
| 能力 | `GET /capabilities` | `protocol: workflow-http-v1`、支持的 operation、输入 schema 版本、限额、取消能力 |
| 提交 | `POST /jobs` | `idempotencyKey`、operation、input、outputSpec；返回 jobId、status |
| 状态 | `GET /jobs/{jobId}` | queued/running/succeeded/failed/cancelled；成功含 outputs；失败含 code/message |
| 取消 | `POST /jobs/{jobId}/cancel` | 显式返回 accepted/cancelled/not_supported/already_terminal |

取消请求返回 accepted 时不马上把任务标为 cancelled；等远端状态确认。时间戳使用 ISO 8601，媒体单位在 schema 中固定为秒、像素和字节。输出条目包含种类、媒体类型、URL、可选 sha256；URL 必须由本项目服务端受控下载。输入采用明确的签名 HTTPS 素材地址或双方声明支持的受限 data URL，不能传本机路径指望远程访问。

幂等语义是本项目对接服务必须实现的契约：同 key/同请求返回同 job；同 key/不同请求返回冲突。服务不支持此语义时，能力声明必须说明，客户端不可假设它存在。新增第三方服务时写专用 translator，而不是不断给通用 JSON 增加隐式字段映射。

## 5. 适配器与任务编排的共同边界

建议按能力暴露四类操作：配置检查、能力查询、同步生成或异步提交、异步查询/取消。由 adapter 解释供应商响应；由 orchestration 层负责项目归属、素材授权、任务租约、限流、重试与产物保存。

每个 provider 配置至少包括：providerKind、可信基址、服务端 secret 引用、精确 model ID、capability profile、配置版本、最后验证时间。业务任务记录配置快照与 provider task ID，避免中途修改配置后轮询到错误服务或模型。

本项目错误类别建议为：`not_configured`、`unsupported_capability`、`invalid_input`、`authentication`、`permission_or_model_access`、`rate_limited`、`quota_exceeded`、`content_rejected`、`upstream_timeout`、`submission_unknown`、`invalid_response`、`artifact_fetch_failed`。

- 配置与参数校验失败时不进入外部队列、不发网络请求。
- 429、5xx 或网络故障只在明确安全的操作上有限重试，尊重 Retry-After；GET 轮询与生成 POST 分开处理。
- POST 超时但无法确定任务是否已建立时记录 `submission_unknown`，不盲目重新提交收费任务。本次研究没有确认 Seedance 官方创建接口提供通用 Idempotency-Key 保证。
- provider task ID 一旦存在，进程恢复优先查询它；不能重启后重新生成。
- 下载失败是本地存储阶段失败，可重新下载已有产物，不能自动重新生成视频。
- 对未知 provider 状态保留原始脱敏值并停止错误终态推断，不能按默认分支当成功。
- 远程素材下载限制协议、DNS/IP、重定向、超时和总字节数；屏蔽内网及云元数据地址。重定向后重新检查目标，认证头不跨未知主机转发。
- 持久化审计只保存必要元数据、脱敏错误、请求追踪 ID；不保存 Authorization、完整 data URL 或供应商密钥。

## 6. 无密钥时的诚实产品状态

区分 `not_configured`、`configured_unverified`、`verified`、`unavailable`。`verified` 还必须按能力记录，例如聊天验证成功不把视频标为通过。

| 状态 | 展示 | 允许行为 |
| --- | --- | --- |
| 未配置 | “尚未配置视频生成服务。配置服务商、模型和 API 密钥后可生成。” | 编辑参数、保存草稿、上传本地素材；生成入口引导配置 |
| 已配置未验证 | “配置已保存，尚未完成真实调用验证。” | 保留配置；显式的验证操作遵循其实际成本，不自动发起收费生成 |
| 能力不支持 | “当前服务不支持声音克隆。” | 保留表单或更换服务；不调用聊天接口伪造结果 |
| 额度/权限不足 | 显示真实失败类别与可执行处理方式 | 修改配置/余额后手动重试；不自动换用别人的服务 |

生成 API 也要独立检查，不能只禁用前端按钮。未配置返回本项目约定的 `503 PROVIDER_NOT_CONFIGURED` 与缺失配置项名称，绝不返回密钥值。配置存在不等于网络连通、模型已开通或账单额度可用；`GET /models` 等探测也不能证明一次完整生成成功。

无密钥时仍可运行并验收真实本地 FFmpeg 流程。演示资产明确标为示例且与用户生成历史分开，不能用延时、占位图或预置视频填补外部生成结果。

## 7. 契约验证与验收门槛

未配置状态、参数校验、HTTP 编解码、状态映射、恢复与产物校验可以用本地 fixture server 验证，但报告必须标为“离线契约测试”，不能写“服务商端到端通过”。

必须覆盖：

1. chat 空 choices、拒绝、截断、格式错误；仅启用实际支持的内容类型。
2. 生图 Base64 正常、坏编码、伪装文件、URL 超限或重定向到内网。
3. speech 音频二进制成功与 JSON 错误响应；检查非零时长。
4. transcription multipart 文件上传、25 MB 边界、时间戳结构、分段偏移和不支持的格式。
5. Seedance 首帧与首尾帧请求结构、模式互斥、data URL 大小预算；服务商排队→运行→成功→下载。
6. queued 取消成功、running 无法取消、取消竞争、expired、未知状态、查询失败与恢复。
7. POST 结果不明不重复提交；进程重启复用 provider task ID；下载失败不重新收费生成。
8. 设置/日志/API 响应没有秘密；用户不能查看另一用户 provider 配置、素材或任务。

只有获得用户提供的独立服务配置并成功执行相应真实请求，才能将该能力标为“真实联调通过”。当前所有外部 AI 能力仍是“官方接口已研究，账户接入及真实调用未验证”。

## 8. 研究自评与剩余限制

- 已核对 OpenAI 官方端点正文，避免把聊天、图片、配音和转写当成相同 JSON 协议。
- 已读取 BytePlus 官方创建页面与查询/取消 Markdown 正文；确认图片 data URL、状态、24 小时 URL 和 7 天记录窗口。
- 火山官方页面部分静态抓取只返回 JavaScript 外壳；本轮具体事实使用其官方页面的搜索索引正文，且与 BytePlus 分别引用。实现前仍应重新查看方舟完整文档/官方 Explorer schema，不把 BytePlus 的全部限制直接复制给方舟。
- Seedance 技能包的 2026-06 快照未当成当前 API 事实；本次当前官方资料已经出现 2.5 和变化后的规格，因此保留按服务商/模型版本的 profile。
- 没有读取或保存密钥，没有创建账户、开通模型或发起计费调用；没有安装 REA。
- 未验证服务商账号权限、地区可用性、费用、配额、实际输出质量、真实人物素材流程或第三方网关兼容性。这些是后续联调项，不能由文档研究替代。

## 9. ElevenLabs：即时音色克隆与配音

### 9.1 最小真实链路

基址 `https://api.elevenlabs.io`，服务端请求头 `xi-api-key: <key>`。即时克隆 IVC 与需要训练/核验的 PVC 分开，首个适配器仅覆盖 IVC。[IVC 官方指南](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/instant-voice-cloning)

| 操作 | 请求 | 成功读取 |
| --- | --- | --- |
| 即时音色克隆 | `POST /v1/voices/add`，multipart `name`、重复的 `files` 二进制文件，可选 `remove_background_noise` | `voice_id`、`requires_verification` |
| 生成配音 | `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`，JSON | 音频二进制流，不是任务 JSON |

克隆文件字段采用 **`files`**。官方 API 页面自动示例写成 `files[]`，但官方 JavaScript SDK 实际序列化为重复的 `files`；实现应与 SDK 一致，并用契约测试固定。`remove_background_noise=false` 是默认值；干净样本开启它可能降低质量。[创建 IVC](https://elevenlabs.io/docs/api-reference/voices/ivc/create)、[官方 JS SDK 序列化代码](https://github.com/elevenlabs/elevenlabs-js/blob/main/src/api/resources/voices/resources/ivc/client/Client.ts)

TTS 最小 JSON：

```json
{
  "text": "Discover a better way to travel.",
  "model_id": "eleven_multilingual_v2"
}
```

本示例使用当前官方明确记录的模型；账户是否可用未测试。`language_code` 不能无条件传给 `eleven_multilingual_v2`，官方注明该模型不支持此参数。语言选择需要按模型支持列表校验，不能为了对应表单而发送无效字段。MP3 返回后必须探测实际音频。[创建配音](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

### 9.2 本地文件、恢复与边界

- 本地音频可以直接 multipart 上传。项目允许上传视频时，由 FFmpeg 先提取音轨；文件扩展名不能替代探测。`10 MB` 是本项目输入规则，不把它写成供应商官方上限。
- 创建返回 `requires_verification=true` 时记录音色 ID 和“等待服务商核验”，阻止后续配音；不能直接显示可用。验证流程未研究完成，标为 **BLOCK**。
- 音色 ID 创建后先持久化，再开始 TTS；配音失败不能自动再建一份克隆。IVC 创建超时且未收到 ID 时保留 `submission_unknown`，本轮没有确认此接口提供幂等键保证。
- 上述 IVC/TTS 接口没有异步任务 ID/轮询契约。中断 HTTP 连接只表示本地停止等待，不能声称远端任务/计费已取消。远端生成取消能力 **BLOCK**；删除声音不是取消配音。
- 本项目仅接受用户有权使用的声音素材；原站提供的展示音色不自动成为本系统的授权音色。模型训练、PVC、账户权益和音色验证尚未接入。

以上恢复和 UI 行为是项目决策，不是额外的供应商 API 字段。无密钥时 `voice.clone`、`speech` 分别显示 `not_configured`，不会退化成普通音色并冒充克隆成功。

## 10. HeyGen：数字人、照片人物与视频翻译

### 10.1 当前版本与素材上传

当前官方文档为 `developers.heygen.com`，本次核对的是 **v3**：基址 `https://api.heygen.com`，鉴权 `x-api-key`。旧示例中的 `/v2/video/generate`、`upload.heygen.com` 与 v3 请求形状不可混用。本次同时核对当前公开 OpenAPI；它属于动态资料，正式实现要固定适配器 profile 与测试 fixture。[官方 API schema](https://developers.heygen.com/openapi/external-api.json)

小文件：`POST /v3/assets`，multipart 字段 `file` 上传真实文件，返回 `data.asset_id/url/mime_type/size_bytes`。官方明确上限 32 MB。图片、音频、视频先上传再传 asset ID，无需向公网开放本地应用。[上传素材](https://developers.heygen.com/reference/upload-asset)

项目的 100 MB 视频不能走上述小文件接口。大文件流程为：

1. `POST /v3/assets/direct-uploads`，JSON 如下；可选 `checksum_sha256` 为 hex。
2. 读取 `data.asset_id/upload_url/upload_headers/expires_in_seconds/max_bytes`。
3. 对 `upload_url` 发 `PUT` 原始文件字节，逐项使用 `upload_headers`，不附带 HeyGen API key。
4. `POST /v3/assets/{asset_id}/complete`，JSON `{}` 或校验和。返回 `data.asset_id/url/mime_type/size_bytes/status`，完成响应的 status 是 `processing`，不是视频生成完成。

```json
{
  "filename": "source.mp4",
  "content_type": "video/mp4",
  "size_bytes": 80000000
}
```

当前大文件契约：音频最多 1,500,000,000 字节，其他支持文件最多 209,715,200 字节；仍以返回的 `max_bytes` 校验。预签名 URL 及 headers 只服务该次上传，不能打印日志或转存前端。[创建直传](https://developers.heygen.com/reference/create-asset-upload)、[完成直传](https://developers.heygen.com/reference/complete-asset-upload)

`GET /v3/assets/{asset_id}` 当前 schema 提供素材元数据和 URL，但没有通用 `status` 字段；不能编造“轮询 status=ready”的流程。完成上传后遇到下游 `resource_not_ready` 时应保存素材 ID，按明确未开始生成的响应做有限重试；实际媒体就绪行为列入真实联调 **BLOCK**。[查询素材](https://developers.heygen.com/reference/get-asset)

### 10.2 现成人物 + 文案或本地音频

先调用 `GET /v3/avatars/looks` 与 `GET /v3/voices`。`avatar_id` 使用 **look 的 id**，不是 group ID；每个 look 的 `supported_api_engines` 决定可选引擎，不从原站人物名称猜测 ID。[数字人生成指南](https://developers.heygen.com/generate-avatar-video)、[查询人物外观](https://developers.heygen.com/reference/get-avatar-look)

`POST /v3/videos`，最小文案驱动形状：

```json
{
  "type": "avatar",
  "avatar_id": "<look-id>",
  "script": "Discover your next everyday essential.",
  "voice_id": "<heygen-voice-id>",
  "resolution": "1080p",
  "aspect_ratio": "auto"
}
```

音频驱动时使用 `audio_asset_id: "<uploaded-audio-id>"`，省略 `script` 与 `voice_id`；另一选项是受服务商可访问的 `audio_url`。字幕配置在 v3 是对象，如 `caption: {"file_format":"srt"}`；需要烧录时可加 `style:"default"`，不能传旧的布尔值。[创建视频](https://developers.heygen.com/reference/create-video)、[音频驱动指南](https://developers.heygen.com/audio-to-video)

### 10.3 上传人物照片

一次性照片驱动：`POST /v3/videos`，把上例的 `type/avatar_id` 换为以下字段，仍使用 `script+voice_id` 或已上传 `audio_asset_id`：

```json
{
  "type": "image",
  "image": { "type": "asset_id", "asset_id": "<uploaded-photo-id>" },
  "audio_asset_id": "<uploaded-audio-id>",
  "resolution": "1080p",
  "aspect_ratio": "auto"
}
```

直接 image 模式的指南不支持 `motion_prompt`/`expressiveness`。本项目表单中的动作描述不能悄悄忽略：使用可支持动作提示的 photo-avatar profile，或明确返回该 profile 不支持此参数。[图片驱动指南](https://developers.heygen.com/image-to-video)

可复用照片人物：`POST /v3/avatars`，JSON `{"type":"photo","name":"My presenter","file":{"type":"asset_id","asset_id":"<photo-id>"}}`。读取 `data.avatar_item.id` 作为后续视频 `avatar_id`。用 `GET /v3/avatars/looks/{look_id}` 查看私有人物状态；仅 `completed` 后允许生成，`processing` 等待，`failed` 展示错误。动作/表情字段需按人物类型与具体 engine 校验。[照片人物指南](https://developers.heygen.com/photo-avatar)、[创建人物](https://developers.heygen.com/reference/create-avatar)

这些接口能让上传的人物照片讲话，不能证明“拿着指定产品、保持包装细节、按动作提示表演”已经实现。`product-avatar` 的产品与人物绑定及实际质量仍为 **BLOCK**，不能以普通说话人物冒充带货成片。视频训练 Digital Twin 的本人同意/训练流程也不由本次最小照片接口替代。

### 10.4 视频翻译

先用 `GET /v3/video-translations/languages` 获取合法目标值。当前请求 schema 要求 `output_languages` 是语言名称列表（例如 `English`、`Spanish (Spain)`），不是可以随意发送的 ISO code；指南部分文字写 code，应以接口实际返回值建立映射。

`POST /v3/video-translations`：

```json
{
  "video": { "type": "asset_id", "asset_id": "<uploaded-video-id>" },
  "output_languages": ["English"],
  "mode": "speed",
  "translate_audio_only": false
}
```

创建返回 `data.video_translation_ids` 数组，每个目标语言一个 ID。持久化全部 ID，分别调用 `GET /v3/video-translations/{video_translation_id}`。目标语言、lip-sync 与字幕是不同选项，不能混为一个布尔字段。[创建视频翻译](https://developers.heygen.com/reference/create-video-translation)

`translate_audio_only=true` 跳过唇形修改；默认会保留原说话者的声音特征。`stock_voice_config` 的预置其他音色是仅指定账户/语言开放的 Enterprise 能力；未确认权限时表单只开放保留原声，不能映射为普通 `voice_id`。当前 `enable_caption` 已废弃并忽略，字幕总会生成，本地决定导出字幕/烧录。[翻译指南](https://developers.heygen.com/docs/video-translate)

成功结果读取 `data.video_url`、可选 `audio_url/srt_caption_url/vtt_caption_url`。如果用户要求视频而响应只有音频，不能将任务直接标为视频成功；须完成本地合成或报告产物不完整。[查询视频翻译](https://developers.heygen.com/reference/get-video-translation)

### 10.5 查询、幂等与取消

| 操作 | 查询路径 | 官方当前状态 |
| --- | --- | --- |
| 数字人/图片视频 | `GET /v3/videos/{video_id}` | pending / processing / completed / failed |
| 视频翻译 | `GET /v3/video-translations/{video_translation_id}` | pending / running / completed / failed |

生成响应读取 `data.video_id`；查询成功视频读取 `data.video_url`，字幕/烧录字幕另读 `subtitle_url/captioned_video_url`。两种任务处理中状态不同，适配器分别映射。创建示例中的初始 `waiting` 与查询 schema 的 `pending` 有差异，本地提交后持久化 ID 进入等待查询，不将未知值当成功。预签名产物 URL 及时下载，过期时重新查询资源取得新 URL。[查询视频](https://developers.heygen.com/reference/get-video)、[数字人指南](https://developers.heygen.com/generate-avatar-video)

v3 创建视频、翻译、上传相关接口支持 `Idempotency-Key`：同路由/资源下 24 小时内重放原响应，执行中为 `409 request_in_progress`。官方允许同 key 略变 body 仍重放，因此本项目必须自行保证同 key 的请求哈希一致，不能用同 key 提交用户修改后的任务。[官方 OpenAPI 的 IdempotencyKey](https://developers.heygen.com/openapi/external-api.json)

**远端取消仍为 BLOCK**。`DELETE /v3/videos/{video_id}` 与 `DELETE /v3/video-translations/{id}` 官方定义为永久删除结果及关联文件，没有承诺取消进行中的生成或停止计费。因此取消按钮只对本地未提交任务可用；已提交显示当前服务不支持已验证的远端取消。不调用删除接口来假装取消。[删除视频](https://developers.heygen.com/reference/delete-video)、[删除翻译](https://developers.heygen.com/reference/delete-video-translation)

### 10.6 研究阶段自评与实施门槛

- 已找到独立专用服务真实契约，`voice.clone/avatar.text/avatar.audio/avatar.photo/video.translate` 不必仅依赖自定义 Workflow 占位。
- 已交叉核对指南、OpenAPI、ElevenLabs 官方 SDK，定位 multipart 字段、HeyGen v3、目标语言值、字幕和状态差异。
- 可先离线验收上传/提交/查询/恢复/产物保存；必须覆盖 HeyGen 32 MB 分界与大文件完成失败、look ID 与 group ID 混用、照片动作字段拒绝、翻译每语言 ID、IVC 需核验、TTS 二进制、取消不支持、幂等 body 不一致。
- 研究阶段未触碰密钥、未上传用户素材、未发起收费请求；当时仅编辑研究文档，后续实现记录如下。
- 无密钥时依然按第 6 节显示未配置。大文件实际就绪、人物/音色资格、翻译音色权限、素材表现和全部真实端到端测试都是 **BLOCK：待独立服务配置和受控联调**；不能以离线测试通过替代。

## 11. 实现记录与真实联调边界（2026-10-14）

本项目已实现 `src/server/providers.ts` 与 `src/server/safe-http.ts`，公开入口为：

```ts
runProvider(ctx: ExecutionContext): Promise<ExecutionResult>
cancelProvider(config: ProviderConfig, remoteTaskId: string, toolId: string):
  Promise<{ cancelled: boolean; supported: boolean; message: string }>
```

OpenAI 聊天、视觉抽帧分析、图片生成/参考编辑、配音和带时间戳识别；Ark 视频任务；ElevenLabs 即时克隆与配音；HeyGen v3 上传、数字人、照片形象及翻译，均已实现专用协议调用。测试使用本机 HTTP fixture 与真实 PNG、MP3、WAV、MP4 和 FFmpeg 验证结果文件，不产生真实模型推理。对话仅传递经过筛选的 user/assistant 历史，视觉分析注明抽样帧及无法观察音轨的限制。

异步 ID 在提交返回后立即写入 `onRemoteTask`，之后恢复查询。多阶段照片形象及音色克隆使用带阶段的持久化检查点。同步付费提交中断、成功响应 JSON 截断或缺少可恢复任务 ID 均返回 `SUBMISSION_UNKNOWN`；ElevenLabs 配音另在提交前保存检查点，恢复时不盲目重复提交。HeyGen 已知就绪冲突只用原请求和同一幂等键有界重试。

网络访问使用逐跳 DNS 检查和连接地址固定，限制内网/保留地址、超时、字节数及重定向；跨源重定向剥离鉴权。`CROSSCUT_ALLOW_LOCAL_PROVIDERS=1` 仅用于离线回环 fixture，不是上线配置。服务商密钥由上层加密保存，适配器不把密钥写入结果或日志。

当前自有工作流协议的可执行子集为：

```json
{
  "GET /capabilities": {
    "protocol": "workflow-http-v1",
    "operations": ["product-avatar", "replication", "link-video", "subtitle-remove"],
    "acceptsDataUrls": true,
    "supportsCancellation": true
  },
  "POST /jobs request": {
    "protocol": "workflow-http-v1",
    "idempotencyKey": "<local-job-id>",
    "operation": "<exact-tool-id>",
    "input": "<complete validated tool-input object>",
    "assets": [{"id": "<asset-id>", "kind": "image", "mime": "image/png", "name": "product.png", "dataUrl": "data:image/png;base64,..."}]
  },
  "POST /jobs response": {"jobId": "<remote-id>"},
  "GET /jobs/<remote-id> response": {
    "status": "succeeded",
    "outputs": [{"kind": "video", "url": "https://<public-artifact-url>", "name": "result.mp4"}]
  },
  "POST /jobs/<remote-id>/cancel response": {"status": "accepted"}
}
```

所有示例仍是协议示意。服务必须自己实现真实生成、同幂等键去重、素材读取及查询；配置一个 URL 不会创建这些模型能力。`operations` 必须显式声明当前工具；取消 `accepted` 不是已经取消。最终文件会下载并验证真实类型，HTML/JSON 假视频不能通过。

仍需清楚展示的限制：

- **真实服务全部待联调**：未配置密钥，没有证明账户权限、模型可用性、外部生成质量、时延或费用。
- Ark 本地参考视频尚缺受控公网素材上传；不会把本机路径或臆测 data URL 传给服务。Seedance 2.5 首尾帧要求自适应比例；不支持的组合明确拒绝。
- ElevenLabs 需要额外核验的克隆音色不能在本项目直接解锁。视频样本提取为 44.1 kHz 单声道，ASR 仍为 16 kHz 单声道。未明确确认核验状态不会立即配音。
- HeyGen 已提交任务的远端取消、专业照片模式和翻译自定义替换音色没有验证契约，明确拒绝；默认使用标准照片模式和翻译原声。大文件直传协议已用真实字节测试，外部服务就绪表现仍待联调。
- GPT Image 输出画幅必要时会本地居中裁切；配音语言不会自动把输入文字翻译；字幕识别只输出真实分段时间码。AI 提示词/语义结论的质量必须在真实模型联调后另验收。
