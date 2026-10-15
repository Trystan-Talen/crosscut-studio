# 服务商配置与外部工作流接入

日期：2026-10-14。本文描述当前代码实际支持的接口。项目没有内置密钥、付费额度或外部推理服务；未执行任何真实付费模型调用。官方接口适配已实现，离线协议测试通过不代表你的账户已经开通对应模型。

## 1. 先区分三种状态

| 状态            | 实际含义                                                                   |
| --------------- | -------------------------------------------------------------------------- |
| 未配置          | 缺少所需服务及密钥，AI 提交会被阻止；本地处理仍可运行                      |
| 已配置，未验证  | 已保存地址、能力和密钥，尚未完成此配置的真实生成                           |
| 已验证 N 项能力 | 该配置下对应能力至少有一项任务返回了经本地校验的产物；其他能力仍需单独验证 |

保存配置不发起测试推理。实际创作会把你选择的文字和素材发送到所选服务，费用由该服务账户结算。修改服务配置会清除验证标记，已提交任务继续使用提交时的配置快照。

以下本地能力不需要服务商：素材/项目/草稿管理、服务器工作流保存和恢复、雷达自有数据的行业层级/日期/关联素材标签筛选、混剪、图集成片、转码、时间裁切、用户提供字幕的烧录、指定区域字幕遮挡/裁切、技术分镜检测。它们不包含自动文案翻译、语义分析或无痕修复模型。

## 2. 在设置中添加配置

打开 **设置 → 服务配置**，添加服务名称、类型、官方 API 基址和密钥，勾选实际支持的能力。高级区域可填写能力模型映射，以及已获授权的音色/角色目录。

- 基址须使用 HTTPS，不能含用户名、密码、查询参数或片段。不要把网页控制台地址当 API 基址。
- 模型解析优先使用 `models[能力名称]`，然后使用默认模型。文字、图片、配音、识别通常需要不同模型，建议逐能力填写。
- 密钥仅保存在本机服务端加密配置中，不向浏览器回显。编辑同类型、同源服务时留空保留旧密钥；更换类型或地址源必须重新提供密钥。
- 音色和人物 ID 来自你自己的服务商账户或其公开授权目录。表单只显示当前服务的目录；切换服务后需重新选择不兼容 ID，后端在入队及外部请求前复验。目录内声明某个 ID 不证明它在服务商账户中的权益有效。
- 目录支持名称/ID搜索，音色按语言/性别筛选，人物按场景/性别筛选；若筛选隐藏了当前选择，界面保留选择并提示。年龄/行业/拍摄角度完整筛选尚未提供；未配置可用预览来源时不提供伪造试听。OpenAI内置声音使用模型对应名单，不能把其他服务的声音ID混入。
- 共享 `provider-limits.ts` 限制当前profile的选项、数量、时长、参考组合和模型特例；前端、任务创建与外部请求前分别校验。不支持的旧值会提示修改，不会静默忽略。未知端点别名采用保守范围；允许选择不等于已经证明远端模型、地区或账户支持。
- 不要在普通启动环境设置 `CROSSCUT_ALLOW_LOCAL_PROVIDERS=1`。它只供离线 fixture 访问回环测试服务器。

音色目录示意：

```json
[{ "id": "<已授权的 voice ID>", "name": "英文口播", "language": "英语", "gender": "女" }]
```

人物目录示意：

```json
[{ "id": "<已授权的 look ID>", "name": "产品讲解人", "scene": "室内", "gender": "女" }]
```

所有 `<...>` 都是需替换的占位符，不能作为实际 ID 提交。配置页面不会自动查询或下载供应商全部人物/音色目录。

### 本轮补齐的业务与执行边界

- **Agent三模式**：创意对话调用chat；视频生成和产品复刻由用户明确选择素材、参数及服务后点击提交，任务关联当前会话。可显式带入最新助手方案，不会因对话自动规划或自动提交收费任务。视频仍需 `video.task`；复刻仍缺实际工作流引擎。
- **工作流恢复**：服务器SQLite草稿保存步骤、每步输入/项目/服务、素材来源、任务/产物ID及批次子任务引用。游戏流程第2步项目、提示词、8秒参数和素材的刷新恢复已由主审验证，见 [恢复证据](evidence/ACCEPT-workflow-resume.jpg)。保存恢复并不生成图像或视频，也不证明多服务AI链已真联调。
- **混剪推荐时长**：默认“推荐时长（30秒）”，是本产品固定规则，不冒充原平台推荐算法。任务保留 `duration="recommended"`；结果及产物元数据保存用户选择和解析后的30秒，结果另存实际探测时长。15秒/30秒仍可手动选择，不需要AI服务。
- **复刻跟随时长**：选择“跟随参考视频”后，服务端从已归属当前用户、已探测的参考资产读取精确时长并保存到任务输入。支持4–60秒，15.5秒不取整；超限或未知时长明确拒绝。实际复刻输出仍需要不存在于本项目中的专用引擎。
- **业务语言与取向**：已补瑞典语/罗马尼亚语映射（sv/ro、Swedish/Romanian）；脚本包含TikTok/通用创作取向，随完整输入传给真实chat模型。这些字段不代表原站专属模型已接入，发音与文案效果仍需真实服务检验。
- **雷达与资料管理**：层级路径“父类 / 子类”来自自己的导入数据，选父类包含下级，旧单层行业继续可用；标签来自关联素材，日期是本地添加日期。系统没有导入原站专有广告库、预测投放指标或给资料补造商业数据。

## 3. 可直连的官方适配器

| 类型         | API 基址                                         | 已实现能力                                                                          | 首次联调要确认                                                  |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `openai`     | `https://api.openai.com/v1`                      | `chat`、`video.analysis`、`image.generate`、`image.edit`、`speech`、`transcription` | 每项配置正确模型；视觉模型可读图片；图像采用 GPT Image 请求格式 |
| `ark`        | `https://ark.cn-beijing.volces.com/api/v3`       | `video.task`                                                                        | 火山方舟账户、模型/接入点 ID、模型输入和地域权限                |
| `ark`        | `https://ark.ap-southeast.bytepluses.com/api/v3` | `video.task`                                                                        | BytePlus 独立账户与模型 ID；不要复用方舟 ID 或默认密钥          |
| `elevenlabs` | `https://api.elevenlabs.io`                      | `speech`、`voice.clone`                                                             | 可用 TTS 模型与 voice ID、即时克隆资格及核验要求                |
| `heygen`     | `https://api.heygen.com`                         | `avatar.text`、`avatar.audio`、`avatar.photo`、`video.translate`                    | v3 API 权限、正确 look ID/voice ID、语言与素材资格              |

“可直连”表示代码实现了官方协议，不表示本项目已经对上述服务完成真实推理验收。协议来源和原始限制详见 [接口研究](adr/provider-contracts-research.md)。

### OpenAI

按能力模型映射示意：

```json
{
  "chat": "<账户支持的 Chat Completions 模型>",
  "video.analysis": "<可通过 Chat Completions 读取图片的模型>",
  "image.generate": "<GPT Image 模型>",
  "image.edit": "<支持参考图片编辑的 GPT Image 模型>",
  "speech": "<支持 audio/speech 的模型>",
  "transcription": "whisper-1"
}
```

| 能力             | 本项目使用的路径             | 产物与限制                                                                             |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| 文案/对话/提示词 | `POST /chat/completions`     | 非流式文本；对话发送有效 user/assistant 历史                                           |
| 视频/图片分析    | `POST /chat/completions`     | 视频先真实抽取8帧及时间点；分镜/机制使用v2有版本JSON并兼容v1，严格检查时间、层级、数量与文本上限；未知字段可为null，不编造音轨或转化事实 |
| 生图             | `POST /images/generations`   | GPT Image Base64 结果；目标比例必要时本地居中裁切                                      |
| 参考图编辑       | `POST /images/edits`         | multipart `image[]`，实际传递参考图                                                    |
| 配音             | `POST /audio/speech`         | 真实 MP3；目标语言不会替你翻译旁白文字                                                 |
| 识别字幕         | `POST /audio/transcriptions` | `whisper-1`的verbose_json分段时间码转SRT；提取16kHz单声道音轨最多25MB，其他模型需明确支持该时间码profile |
| 可选字幕翻译 | `POST /chat/completions` | 同一Provider须预先配置chat能力与对应模型；只替换分段文本、保持原时码，校验段数并按段序回填。未具备依赖时在收费识别前拒绝；翻译质量和完整E2E尚未验证 |

新版拆解字段与展示边界：

- 分镜包含阶段时间、目的/内容以及逐镜头景别、视角、动作、屏幕文字和中文释义；机制包含优势/短板/优先动作、目标、时间段证据、原理/问题/行动/预期收益。预期收益明确为建议推测，不是已有投放结果或承诺。
- `null`表示无法从证据判断；屏幕文字的空字符串表示可确认没有文字。提示词要求生成目标、锚点、逐镜头计划、连续性和约束，新增声音只能标为建议，不能写成已观察事实。
- 时码必须有限且满足0≤start<end≤真实时长，镜头包含在阶段中、同序列有序不重叠；不满足时响应不能作为成功结果保存。已收到2xx响应后处理失败进入 `RESULT_PROCESSING_FAILED`，不普通重试再次收费。
- 主审已验证人工v2样例完整渲染、历史组合筛选、清空提示词后刷新，以及真实15秒视频在0–1.5秒播放区间末端暂停。见 [v2样例](evidence/ACCEPT-analysis-rich-fixture.jpg)、[实际播放测量](evidence/ACCEPT-analysis-interval.json)。人工结构内容和离线HTTP响应都不是视觉模型质量验收。

第三方“OpenAI 兼容”服务需要逐端点验证，聊天可用不证明生图或配音可用。当前配置界面使用以上固定 profile，不支持任意字段映射或自动回退到猜测接口。官方资料：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Images](https://developers.openai.com/api/reference/resources/images/methods/generate)、[Audio](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)。

### Ark / BytePlus Seedance

选择 `video.task`，默认模型或 `models["video.task"]` 填写当前账户开通的准确模型 ID。项目不会把原站展示名称转换成猜测 ID。

- 提交 `/contents/generations/tasks`，取得 ID 后持久化并查询；生成成功后下载并验证实际视频。
- 文本、首尾帧、本地图片/音频参考已有实现；首尾帧顺序与素材选择顺序一致。
- 本地参考视频目前缺少受控公网素材上传，明确返回不支持，不能使用本机路径或未经文档支持的视频 data URL。
- 常规profile使用4–15整数秒；识别到的2.5 profile最长30秒，首尾帧模式只能选择auto。未知端点别名不会被假定支持任意新模型参数。文字模式不接收参考素材；首尾帧为1–2图片；参考模式为1–9图片、可附加至多3音频，音频不能独立提交。
- 参考图片校验实际边长300–6000像素及宽高比0.4–2.5；前端与服务端采用同一限制定义。其他模型/账户支持仍需供应商真实确认。
- 图片原始大小及编码后的 64 MB 请求上限分别检查。批量数量由本地拆分，每条子任务对应一个真实远端任务。
- 仅服务端仍为 `queued` 的任务尝试取消，之后再查询确认。运行中不支持取消；不删除完成结果来伪装取消。

官方资料：[方舟视频教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh)、[BytePlus 视频教程](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/video-generation-tutorial)。

### ElevenLabs

模型示例 `eleven_multilingual_v2`，是否有权限需在账户确认。可分别设置 `models["speech"]` 和 `models["voice.clone"]`；后者指定克隆后试听配音使用的 TTS 模型。普通配音需要现有 voice ID；克隆使用授权样本创建真实 voice ID，再执行配音。

- 即时克隆调用 `POST /v1/voices/add`；本地音频直接上传，视频先提取 44.1 kHz 单声道 WAV。
- `remove_background_noise` 按去背景杂音选项传递。授权确认是必填输入。
- 服务返回 `requires_verification:true` 或未明确给出核验状态时，保存音色检查点并停止配音。本项目不实现身份核验/解锁流程。
- 克隆音色 ID 保存后可恢复；配音提交前也保存检查点。请求结果不明时不自动重复扣费生成。
- `eleven_multilingual_v2` 根据输入文字发音，不发送其不支持的 `language_code`。配音文字必须已经是目标语言。常规模型语速范围 0.7–1.2；v3 profile 仅接受默认语速。
- 不支持远端中止已提交的克隆或同步配音。

官方资料：[即时音色克隆](https://elevenlabs.io/docs/api-reference/voices/ivc/create)、[文字转语音](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)。

### HeyGen v3

数字人引擎可填 `avatar_iv`；本适配器识别 `avatar_iv`、`avatar_v`、`avatar_iii`，模型是否对账户开放需确认。仅翻译时可留空默认模型。

- 文本数字人使用实际 look ID 和 voice ID，发送文案、语言、语速、音量和比例；有字幕时读取返回的 SRT 并本地烧录样式。当前 33 个静态字幕预设与本地字幕工具共用 `src/shared/subtitle-styles.ts`，颜色、位置、描边等由本地渲染完成，不把自定义样式 ID 冒充 HeyGen 参数；选择 `none` 不烧录，未知预设在收费提交前拒绝。预设不声称提供逐字跟随或动画效果。
- 音频数字人上传本地音频，使用 `audio_asset_id`，不会把音频替换为伪造文案。
- 自定义照片数字人先 `POST /v3/avatars` 创建照片形象，持久化并等待 look 完成，再上传口播音频、创建视频。Avatar IV 支持本 profile 的动作提示；“专业模式”参数暂未验证，表单按profile限制且服务器明确拒绝，不自动替换成标准模式。
- 文件最多 32 MB 使用 `/v3/assets` multipart；更大文件走 direct-upload 申请、签名 PUT、完成确认。签名 PUT 不携带 HeyGen API 密钥。
- 视频翻译先读取 `/v3/video-translations/languages`，将选择语言映射到服务实际支持项，再提交单语言翻译。`lipSync=false` 对应只翻译音频；显示字幕会把服务实际 SRT 烧录到成片。
- 翻译自定义替换 voice ID 的企业能力尚未实现，本 profile 保留原声。远端取消未有可确认契约，不调用永久删除 API。
- 已知素材未就绪或相同请求处理中的 409 响应，只用相同请求体和幂等键有界重试。照片形象跨阶段恢复超过安全幂等窗口会进入待核对状态。

官方资料：[数字人指南](https://developers.heygen.com/generate-avatar-video)、[v3 OpenAPI](https://developers.heygen.com/openapi/external-api.json)。

## 4. 需要独立实现的专用工作流

`product-avatar`（手持商品）、`replication`（完整广告复刻）、`link-video`（链接到成片）和 `subtitle-remove` 的 `inpaint`（无痕修复）**缺少实际专用引擎实现**，不是只缺一个API密钥。当前交付是严格的HTTP客户端协议；对应服务端算法、模型、对象存储、任务编排和算力仍需另行实现或接入。

链接工具中的模板/风格名称、字幕预设参数以及复刻的跟随时长仅是已实现输入和传输约定；没有模板合成/专用生成服务，不能据此称成片能力完成。原站26模板/46风格、完整专属模型/素材库也未交付。

普通 OpenAI 聊天或 HeyGen 数字人不能自动获得这四项能力。请不要把标准 OpenAI/Ark/HeyGen 基址填为 `workflow`，它们不会自行实现以下协议。

| 本地工具       | 配置能力                   | 服务声明 operation |
| -------------- | -------------------------- | ------------------ |
| 手持商品数字人 | `workflow:product-avatar`  | `product-avatar`   |
| 爆款复刻       | `workflow:replication`     | `replication`      |
| 链接生视频     | `workflow:link-video`      | `link-video`       |
| 智能字幕修复   | `workflow:subtitle-remove` | `subtitle-remove`  |

选用本地 `cover/crop` 模式的字幕处理无需该服务；它只做明确区域遮挡/裁切，不能当作智能擦除。

## 5. workflow-http-v1 的完整最小契约

这是本项目自有协议。所有请求由服务端携带 `Authorization: Bearer <你配置的密钥>`，基址为接入方实际部署的 HTTPS 服务。以下 JSON 只是协议示意，不是已运行结果。

### 能力发现

`GET /capabilities`：

```json
{
  "protocol": "workflow-http-v1",
  "operations": ["link-video", "replication"],
  "acceptsDataUrls": true,
  "supportsCancellation": true
}
```

必须声明本次使用的精确 tool ID。有素材时必须明确 `acceptsDataUrls:true`。不要声明尚未实现的 operation。未声明取消能力时 UI 不会把远端取消视为支持。

### 创建任务

`POST /jobs`，同时发送头 `Idempotency-Key: <local-job-id>`：

```json
{
  "protocol": "workflow-http-v1",
  "idempotencyKey": "<local-job-id>",
  "operation": "link-video",
  "input": {
    "url": "https://example.com/product",
    "script": "用户确认的广告脚本",
    "language": "英语",
    "ratio": "9:16",
    "duration": 30
  },
  "assets": [
    {
      "id": "<asset-id>",
      "kind": "image",
      "mime": "image/png",
      "name": "product.png",
      "dataUrl": "data:image/png;base64,<实际编码>"
    }
  ]
}
```

`input` 是完整的已验证工具输入对象，字段见 [共享目录](../src/shared/catalog.ts)。包含 `sourceIds/imageIds/audioIds/videoIds` 时，通过 `assets[].id` 关联实际字节；它不包含可供远程访问的本地文件路径。上例 link-video 通常没有本地 assets；素材数组形状用于说明协议。

单素材最多 40 MB，完整 JSON 最多 64 MB；Base64 膨胀计入限制。远端必须保证同 key、同输入返回同任务；同 key、不同输入拒绝。创建响应：

```json
{ "jobId": "<remote-job-id>", "status": "queued" }
```

`jobId` 必須是非空字符串，不能只返回“已成功”文字。取得 ID 后本项目立即持久化，后续恢复优先查询。

### 查询和产物

`GET /jobs/<remote-job-id>` 的状态只能使用 `queued`、`running`、`succeeded`、`failed`、`cancelled`。成功示意：

```json
{
  "status": "succeeded",
  "outputs": [
    {
      "kind": "video",
      "url": "https://<公开可下载的产物地址>",
      "name": "ad.mp4"
    }
  ],
  "result": { "summary": "可选的结构化结果" }
}
```

输出支持 `image/video/audio`；以上四项专用工作流必须至少包含一个视频。下载地址须能由本机服务端直接 GET，无需另一套自定义鉴权头；可用短期签名 HTTPS URL。每次返回的 URL 应仍有效。禁止内网地址、`file:`、`blob:`；返回 HTML/JSON、空文件或与声明类型不同的文件会失败。单项下载上限 210 MiB，成功后仍需本地解码校验和入库，才算用户任务成功。

失败使用 `{"status":"failed"}`；远端任意错误原文不会直接作为可信业务结果呈现。运行超过本次等待窗口时保留 ID，恢复查询，不自动再创建任务。

### 取消

`POST /jobs/<remote-job-id>/cancel`，JSON `{}`。响应须使用以下语义：

| `status`           | 本地行为                             |
| ------------------ | ------------------------------------ |
| `cancelled`        | 远端已确认取消，可终止本地任务       |
| `accepted`         | 请求已收到，继续轮询直到远端确认终态 |
| `not_supported`    | 明确显示无法取消                     |
| `already_terminal` | 继续核对已结束结果，不假报已取消     |

取消接口必须停止或明确说明不能停止远端计算，不能只删除数据库记录。若创建提交超时、网络断开、响应截断或缺少 ID，本项目显示“结果待核对”，不会为了生成一个新编号自动重复提交。

## 6. 首次真实联调与故障处理

每项能力先用一个你有权使用的小素材执行单条任务，观察队列事件，预览并下载真实产物，核对画面/音轨、时长、语言、比例、字幕与输入设置。再测试该能力的失败处理和可支持的恢复。检查服务商账单后再增加批量数量。

| 状态或错误                                        | 处理方法                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PROVIDER_NOT_CONFIGURED`                         | 检查能力、真实模型 ID、密钥和基址                                                                          |
| `PROVIDER_AUTHENTICATION / PROVIDER_PERMISSION`   | 在服务商确认密钥、模型权限、地域和额度；项目不会替你购买                                                   |
| `UNSUPPORTED_CAPABILITY`                          | 按提示调整模型/模式或配置真正实现此能力的服务，不会忽略选项继续跑                                          |
| `VOICE_VERIFICATION_REQUIRED`                     | 在 ElevenLabs 完成资格/核验；当前项目不提供远端核验操作                                                    |
| `REMOTE_PENDING`                                  | 已保存任务 ID，等待恢复查询                                                                                |
| `SUBMISSION_UNKNOWN` / 结果待核对                 | 先核对远端是否已受理和计费；本地禁止盲目重发                                                               |
| `RESULT_PROCESSING_FAILED / RESULT_COMMIT_FAILED` | 服务商已返回成功响应，但下载、校验、后处理或本地保存未完成；先核对远端产物和账单，本地阻止普通重试重复收费 |
| `REMOTE_FAILED / REMOTE_EXPIRED`                  | 远端已终止；如需新生成，从原参数创建新任务并承担新的调用费用                                               |
| 无法取消                                          | 由供应商实际能力决定，停止本地等待不能证明停止远端计算或计费                                               |

本项目没有原站积分充值、兑换、赠送、过期与订单商业体系，也未提供@素材引用编辑器或原站全部模板/专属模型；这些缺口不因可配置接口而消失。

离线fixture仅证明请求形状、状态处理、安全下载及本地媒体链路，人工UI样例仅证明结构展示；外部模型质量与账号能力仍需真实联调。6项资料检索、14项限制、44项Provider、18项分析schema等是分次专项，不能相加作为最终全量通过结论。最终完整检查与逐项验收报告由主审另行保存。
