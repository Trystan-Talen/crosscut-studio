import { useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Cpu,
  KeyRound,
  Link2,
  Plus,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ProviderKind, ProviderPublic, User } from "../../shared/types";
import { bytes, date, message, patch, post, remove, useQuery } from "../api";
import { useWorkspace } from "../context";
import { PasswordForm } from "../components/PasswordForm";
import {
  CopyButton,
  Drawer,
  Empty,
  ErrorPanel,
  Loading,
  Notice,
  PageTitle,
  StructuredResult,
} from "../ui";

const providerNames: Record<ProviderKind, string> = {
  openai: "OpenAI / 兼容服务",
  ark: "火山方舟",
  elevenlabs: "ElevenLabs",
  heygen: "HeyGen",
  workflow: "兼容工作流网关",
};
export function Settings() {
  const { user, setUser, providers, tools, refresh, notify } = useWorkspace();
  const [tab, setTab] = useState("providers");
  const [edit, setEdit] = useState<ProviderPublic | "new" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const runtime = useQuery<{
    node: string;
    ffmpeg: string;
    ffprobe: string;
    sqliteVersion: string;
    dataDir: string;
    worker: unknown;
    storageBytes: number;
  } | null>(tab === "runtime" ? "/settings/runtime" : null, null);
  const usage = useQuery<{ items: Record<string, unknown>[]; total: number }>(
    tab === "usage" ? "/usage" : null,
    { items: [], total: 0 },
  );
  async function profile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(
      new FormData(event.currentTarget),
    ) as Record<string, string>;
    const { name, ...fields } = values;
    try {
      const result = await patch<User>("/me", { name, profile: fields });
      setUser(result);
      notify("个人资料已保存");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="MAKE IT YOURS"
        title="让创作空间，更适合你。"
        description="管理个人资料、模型服务与本地运行状态。"
      />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {[
            { id: "providers", name: "模型与服务", icon: KeyRound },
            { id: "profile", name: "个人资料", icon: UserRound },
            { id: "usage", name: "调用记录", icon: CheckCircle2 },
            { id: "runtime", name: "运行信息", icon: Server },
          ].map((item) => (
            <button
              className={tab === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={17} />
              {item.name}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === "providers" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>你的模型服务</h2>
                  <p>
                    仅使用你配置的服务和密钥。每次外部任务都会说明发送的内容。
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setEdit("new")}
                >
                  <Plus size={16} />
                  添加服务
                </button>
              </div>
              <Notice>
                本地混剪、转码和技术分镜检测无需密钥。保存服务配置仅表示接入资料已保存，不代表真实推理已通过验证。
              </Notice>
              {providers.length ? (
                providers.map((provider) => (
                  <article className="panel provider-card" key={provider.id}>
                    <div className="row">
                      <div className="provider-title">
                        <span className="tool-icon">
                          <Cpu size={23} />
                        </span>
                        <div>
                          <h3>{provider.name}</h3>
                          <p>{providerNames[provider.kind]}</p>
                        </div>
                      </div>
                      <span
                        className={`availability ${provider.configured ? "is-ready" : ""}`}
                      >
                        {provider.status === "verified"
                          ? `已验证 ${provider.verifiedCapabilities?.length ?? 0} 项能力`
                          : provider.configured
                            ? "已配置 · 待验证"
                            : "未配置"}
                      </span>
                    </div>
                    <div className="provider-facts">
                      {provider.verifiedCapabilities?.length ? (
                        <span>
                          实际验证：
                          {provider.verifiedCapabilities
                            .map(
                              (capability) =>
                                tools.find((t) => t.capability === capability)
                                  ?.title ?? capability,
                            )
                            .join("、")}
                        </span>
                      ) : null}
                      <span>
                        <Link2 size={14} />
                        {provider.baseUrl}
                      </span>
                      <span>默认模型：{provider.model || "未设置"}</span>
                    </div>
                    <div className="tag-list">
                      {provider.capabilities.map((capability) => (
                        <span key={capability}>
                          {tools.find((t) => t.capability === capability)
                            ?.title ?? capability}
                        </span>
                      ))}
                    </div>
                    <div className="row">
                      <small className="muted">
                        更新于 {date(provider.updatedAt)}
                      </small>
                      <div className="actions">
                        <button
                          className="text-button"
                          onClick={() => setEdit(provider)}
                        >
                          编辑配置
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`停用${provider.name}`}
                          onClick={() =>
                            void remove(`/providers/${provider.id}`)
                              .then(() => {
                                refresh();
                                notify("服务已停用，已有任务记录保留");
                              })
                              .catch((e) => notify(message(e)))
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="panel">
                  <Empty
                    icon={KeyRound}
                    title="为 AI 创作接入第一项服务"
                    detail="添加模型、配音或数字人服务，解锁对应创作工具。"
                  >
                    <button
                      className="button primary"
                      onClick={() => setEdit("new")}
                    >
                      <Plus size={16} />
                      添加模型服务
                    </button>
                  </Empty>
                </div>
              )}
            </>
          )}
          {tab === "profile" && (
            <>
              <form
                className="panel profile-form"
                onSubmit={(e) => void profile(e)}
              >
                <h2>个人资料</h2>
                <p className="muted">这些资料用于你的本地创作空间。</p>
                <div className="profile-avatar">{user.name.slice(0, 1)}</div>
                <label className="field">
                  <span>你的名字</span>
                  <input
                    required
                    name="name"
                    defaultValue={user.name}
                    maxLength={60}
                  />
                </label>
                <label className="field">
                  <span>登录邮箱</span>
                  <input value={user.email} readOnly />
                </label>
                <div className="account-id">
                  <label className="field">
                    <span>本地账户 ID</span>
                    <input value={user.id} readOnly />
                  </label>
                  <CopyButton text={user.id} label="复制 ID" />
                </div>
                <div className="form-two">
                  <label className="field">
                    <span>行业</span>
                    <select
                      name="industry"
                      defaultValue={user.profile.industry ?? "电商"}
                    >
                      {["电商", "游戏", "短剧", "应用", "其他"].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>岗位</span>
                    <select name="role" defaultValue={user.profile.role ?? ""}>
                      <option value="">选择岗位</option>
                      {["视频设计师", "视频优化师", "投手", "其他"].map(
                        (value) => (
                          <option key={value}>{value}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="field">
                    <span>媒体平台</span>
                    <select
                      name="platform"
                      defaultValue={user.profile.platform ?? ""}
                    >
                      <option value="">选择平台</option>
                      {["TikTok", "Meta", "Google", "其他"].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>日均预算（美元）</span>
                    <input
                      name="budget"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={user.profile.budget ?? ""}
                    />
                  </label>
                </div>
                {error && <ErrorPanel error={error} />}
                <button className="button primary" disabled={busy}>
                  保存资料
                </button>
              </form>
              <PasswordForm />
            </>
          )}
          {tab === "runtime" && (
            <section className="panel">
              <h2>本地运行信息</h2>
              {runtime.error && (
                <ErrorPanel error={runtime.error} retry={runtime.refresh} />
              )}
              {runtime.loading ? (
                <Loading />
              ) : (
                runtime.data && (
                  <>
                    <div className="runtime-banner">
                      <ShieldCheck size={29} />
                      <div>
                        <strong>素材与数据存储在本机</strong>
                        <p>
                          在进行迁移或备份前，请使用项目提供的停止与备份工具。
                        </p>
                      </div>
                    </div>
                    <dl className="runtime-list">
                      {[
                        ["Node.js", runtime.data.node],
                        ["FFmpeg", runtime.data.ffmpeg],
                        ["FFprobe", runtime.data.ffprobe],
                        ["SQLite", runtime.data.sqliteVersion],
                        ["数据目录", runtime.data.dataDir],
                        ["存储占用", bytes(runtime.data.storageBytes)],
                      ].map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <details className="details">
                      <summary>任务处理服务</summary>
                      <StructuredResult value={runtime.data.worker} />
                    </details>
                  </>
                )
              )}
            </section>
          )}
          {tab === "usage" && (
            <section className="panel">
              <h2>真实调用记录</h2>
              <p className="muted">
                只显示服务返回的实际使用记录，不推算服务商费用。
              </p>
              {usage.error && (
                <ErrorPanel error={usage.error} retry={usage.refresh} />
              )}
              {usage.loading ? (
                <Loading />
              ) : usage.data.items.length ? (
                <div className="usage-list">
                  {usage.data.items.map((item, index) => (
                    <details className="details" key={String(item.id ?? index)}>
                      <summary>
                        {String(
                          item.toolId ??
                            item.tool_id ??
                            item.capability ??
                            "模型调用",
                        )}{" "}
                        · {String(item.createdAt ?? item.created_at ?? "")}
                      </summary>
                      <StructuredResult value={item} />
                    </details>
                  ))}
                </div>
              ) : (
                <Empty
                  title="还没有服务调用记录"
                  detail="真实外部任务执行后，使用信息会显示在这里。"
                />
              )}
            </section>
          )}
        </div>
      </div>
      <Drawer
        open={!!edit}
        title={edit === "new" ? "添加模型服务" : "编辑模型服务"}
        onClose={() => setEdit(null)}
        wide
      >
        {edit && (
          <ProviderForm
            key={typeof edit === "string" ? "new" : edit.id}
            value={edit === "new" ? undefined : edit}
            onSaved={() => {
              setEdit(null);
              refresh();
              notify("服务配置已保存，真实执行验证仍需单独完成");
            }}
          />
        )}
      </Drawer>
    </>
  );
}
function ProviderForm({
  value,
  onSaved,
}: {
  value?: ProviderPublic;
  onSaved: () => void;
}) {
  const { tools } = useWorkspace();
  const [kind, setKind] = useState<ProviderKind>(value?.kind ?? "openai");
  const [capabilities, setCapabilities] = useState<string[]>(
    value?.capabilities ?? [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const available = adapterCapabilities[kind];
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(
      new FormData(event.currentTarget),
    ) as Record<string, string>;
    setBusy(true);
    setError("");
    try {
      const models = JSON.parse(data.models || "{}") as Record<string, string>;
      const voices = JSON.parse(data.voices || "[]") as unknown[];
      const avatars = JSON.parse(data.avatars || "[]") as unknown[];
      if (!capabilities.length) throw new Error("至少选择一项实际支持的能力。");
      await post("/providers", {
        id: value?.id,
        name: data.name,
        kind,
        baseUrl: data.baseUrl,
        model: data.model,
        apiKey: data.apiKey || undefined,
        capabilities,
        models,
        voices,
        avatars,
      });
      onSaved();
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? "模型映射或目录 JSON 格式不正确，请检查括号和引号。"
          : message(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="form-two">
        <label className="field">
          <span>服务名称 *</span>
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={value?.name}
            placeholder="例如：我的视频服务"
          />
        </label>
        <label className="field">
          <span>服务类型 *</span>
          <select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as ProviderKind;
              setKind(next);
              setCapabilities((values) =>
                values.filter((capability) =>
                  adapterCapabilities[next].includes(capability),
                ),
              );
            }}
          >
            {Object.entries(providerNames).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>服务地址 *</span>
        <input
          name="baseUrl"
          required
          type="url"
          defaultValue={value?.baseUrl}
          placeholder="填写服务商官方 API 地址"
        />
        <small>
          只连接你信任的服务。兼容工作流网关需符合项目文档中的接口契约。
        </small>
      </label>
      <div className="form-two">
        <label className="field">
          <span>默认模型 ID</span>
          <input
            name="model"
            defaultValue={value?.model}
            placeholder="服务商文档中的真实模型 ID"
          />
        </label>
        <label className="field">
          <span>API 密钥{value && <small>留空保留已保存的密钥</small>}</span>
          <input
            name="apiKey"
            type="password"
            autoComplete="new-password"
            placeholder={
              value?.configured ? "已安全保存，不回显" : "输入 API 密钥"
            }
          />
        </label>
      </div>
      <fieldset className="capability-checks">
        <legend>启用支持的能力</legend>
        <p className="small muted">
          仅选择此服务及模型实际支持的能力，声明能力不会自动实现服务商未提供的接口。
        </p>
        {available.map((capability) => (
          <label key={capability}>
            <input
              type="checkbox"
              checked={capabilities.includes(capability)}
              onChange={(e) =>
                setCapabilities((v) =>
                  e.target.checked
                    ? [...v, capability]
                    : v.filter((c) => c !== capability),
                )
              }
            />
            <span>
              {tools.find((t) => t.capability === capability)?.title ??
                (capability === "image.edit"
                  ? "图像编辑"
                  : capability === "workflow:subtitle-remove"
                    ? "智能字幕修复"
                    : capability)}
              <small>{capability}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <details className="details">
        <summary>高级：模型映射、授权音色与角色目录</summary>
        <label className="field">
          <span>按能力指定模型（JSON 对象）</span>
          <textarea
            name="models"
            defaultValue={JSON.stringify(value?.models ?? {}, null, 2)}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>授权音色目录（JSON 数组）</span>
          <textarea
            name="voices"
            defaultValue={JSON.stringify(value?.voices ?? [], null, 2)}
            placeholder='[{"id":"voice-id","name":"名称","language":"中文"}]'
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>授权角色目录（JSON 数组）</span>
          <textarea
            name="avatars"
            defaultValue={JSON.stringify(value?.avatars ?? [], null, 2)}
            placeholder='[{"id":"avatar-id","name":"角色名称","scene":"室内"}]'
            spellCheck={false}
          />
        </label>
      </details>
      <Notice>
        此步骤只保存配置，不发送测试文字或素材，不发起收费推理。首次执行后应核验任务产物。
      </Notice>
      {error && <ErrorPanel error={error} />}
      <button className="button primary" disabled={busy}>
        <KeyRound size={16} />
        {busy ? "正在保存…" : "保存服务配置"}
      </button>
    </form>
  );
}

const adapterCapabilities: Record<ProviderKind, string[]> = {
  openai: [
    "chat",
    "image.generate",
    "image.edit",
    "speech",
    "transcription",
    "video.analysis",
  ],
  ark: ["video.task"],
  elevenlabs: ["voice.clone", "speech"],
  heygen: ["avatar.text", "avatar.audio", "avatar.photo", "video.translate"],
  workflow: [
    "workflow:product-avatar",
    "workflow:replication",
    "workflow:link-video",
    "workflow:subtitle-remove",
    "video.task",
    "avatar.text",
    "avatar.audio",
    "avatar.photo",
    "voice.clone",
    "video.translate",
  ],
};
