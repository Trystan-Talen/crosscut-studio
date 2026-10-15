import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  CircleDot,
  Clapperboard,
  Compass,
  FolderOpen,
  LayoutDashboard,
  Layers3,
  LogOut,
  Menu,
  PanelLeftClose,
  Scissors,
  Settings2,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type {
  Asset,
  Project,
  ProviderPublic,
  Tool,
  User,
} from "../shared/types";
import { message, navigate, post, useQuery, useRoute } from "./api";
import { Context } from "./context";
import { PageBoundary } from "./components/PageBoundary";
import { ErrorPanel, Loading } from "./ui";
import { Dashboard } from "./pages/Dashboard";
const Studio = lazy(() =>
  import("./pages/Studio").then((m) => ({ default: m.Studio })),
);
const Library = lazy(() =>
  import("./pages/Library").then((m) => ({ default: m.Library })),
);
const Projects = lazy(() =>
  import("./pages/Projects").then((m) => ({ default: m.Projects })),
);
const Tasks = lazy(() =>
  import("./pages/Tasks").then((m) => ({ default: m.Tasks })),
);
const Settings = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.Settings })),
);
const Radar = lazy(() =>
  import("./pages/Radar").then((m) => ({ default: m.Radar })),
);
const Analysis = lazy(() =>
  import("./pages/Analysis").then((m) => ({ default: m.Analysis })),
);
const Agent = lazy(() =>
  import("./pages/Agent").then((m) => ({ default: m.Agent })),
);
const Workflows = lazy(() =>
  import("./pages/Workflows").then((m) => ({ default: m.Workflows })),
);

const navigation = [
  {
    label: "制作",
    items: [
      { id: "home", name: "工作台", icon: LayoutDashboard },
      { id: "studio", name: "创作工作室", icon: Clapperboard },
      { id: "agent", name: "创意 Agent", icon: Bot },
      { id: "workflows", name: "创意工作流", icon: Workflow },
    ],
  },
  {
    label: "研究",
    items: [
      { id: "radar", name: "灵感雷达", icon: Compass },
      { id: "analysis", name: "视频拆解", icon: Scissors },
      { id: "replication", name: "爆款复刻", icon: Layers3 },
    ],
  },
  {
    label: "空间",
    items: [
      { id: "library", name: "素材库", icon: FolderOpen },
      { id: "projects", name: "项目", icon: Layers3 },
      { id: "tasks", name: "任务记录", icon: CircleDot },
      { id: "settings", name: "设置", icon: Settings2 },
    ],
  },
];
export function App() {
  const status = useQuery<{ initialized: boolean; user: User | null }>(
    "/auth/status",
    { initialized: true, user: null },
  );
  useEffect(() => {
    const expired = () => status.refresh();
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [status.refresh]);
  if (status.loading)
    return (
      <div className="startup">
        <div className="brand dark">
          crosscut
          <Logo />
        </div>
        <Loading />
      </div>
    );
  if (status.error)
    return (
      <div className="startup">
        <ErrorPanel error={status.error} retry={status.refresh} />
      </div>
    );
  if (!status.data.user)
    return (
      <Auth
        setup={!status.data.initialized}
        onSuccess={(user) => status.setData({ initialized: true, user })}
      />
    );
  return (
    <Workspace
      user={status.data.user}
      setUser={(user) => status.setData({ initialized: true, user })}
      onLogout={() => status.setData({ initialized: true, user: null })}
    />
  );
}
function Workspace({
  user,
  setUser,
  onLogout,
}: {
  user: User;
  setUser: (u: User) => void;
  onLogout: () => void;
}) {
  const route = useRoute();
  const [mobile, setMobile] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuClose = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useState("");
  const tools = useQuery<{ items: Tool[] }>("/tools", { items: [] });
  const providers = useQuery<{ items: ProviderPublic[] }>("/providers", {
    items: [],
  });
  const projects = useQuery<{ items: Project[] }>("/projects", { items: [] });
  const assets = useQuery<{ items: Asset[] }>("/assets", { items: [] });
  const refresh = () => {
    tools.refresh();
    providers.refresh();
    projects.refresh();
    assets.refresh();
  };
  function closeMobile() {
    setMobile(false);
    menuButton.current?.focus();
  }
  const screenKey =
    route.page === "studio"
      ? `${route.page}:${route.params.get("tool") ?? "directory"}`
      : route.page;
  useEffect(() => {
    setMobile(false);
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, 0));
    return () => window.cancelAnimationFrame(frame);
  }, [screenKey]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!mobile) return;
    menuClose.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobile();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [mobile]);
  const name =
    navigation.flatMap((n) => n.items).find((n) => n.id === route.page)?.name ??
    "创作空间";
  let content;
  switch (route.page) {
    case "studio":
    case "replication":
      content = (
        <Studio
          key={`${route.page}:${route.params.toString()}`}
          params={route.params}
          replication={route.page === "replication"}
        />
      );
      break;
    case "library":
      content = <Library />;
      break;
    case "projects":
      content = <Projects params={route.params} />;
      break;
    case "tasks":
      content = <Tasks params={route.params} />;
      break;
    case "settings":
      content = <Settings />;
      break;
    case "radar":
      content = <Radar />;
      break;
    case "analysis":
      content = <Analysis params={route.params} />;
      break;
    case "agent":
      content = <Agent />;
      break;
    case "workflows":
      content = <Workflows />;
      break;
    default:
      content = <Dashboard />;
  }
  return (
    <Context.Provider
      value={{
        user,
        setUser,
        tools: tools.data.items,
        providers: providers.data.items,
        projects: projects.data.items,
        assets: assets.data.items,
        refresh,
        notify: setToast,
      }}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳至主要内容
      </a>
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={closeMobile}
        />
      )}
      <aside
        id="main-navigation"
        className={`sidebar ${mobile ? "mobile-open" : ""}`}
      >
        <div className="brand">
          crosscut
          <Logo />
          <button
            ref={menuClose}
            className="icon-button sidebar-close"
            aria-label="关闭导航"
            onClick={closeMobile}
          >
            <PanelLeftClose size={20} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">C</span>
          <span>
            我的创作空间<small>LOCAL WORKSPACE</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="主导航">
          {navigation.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-caption">{group.label}</div>
              {group.items.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className={route.page === item.id ? "active" : ""}
                  aria-current={route.page === item.id ? "page" : undefined}
                >
                  <item.icon size={18} strokeWidth={1.6} />
                  <span>{item.name}</span>
                  {item.id === "studio" && <span className="nav-dot" />}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="live-dot" />
          <div>
            你的内容，留在本地<small>SQLite · 独立创作空间</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="crumb">
            <button
              ref={menuButton}
              className="icon-button mobile-menu"
              aria-label="打开导航"
              aria-expanded={mobile}
              aria-controls="main-navigation"
              onClick={() => (mobile ? closeMobile() : setMobile(true))}
            >
              <Menu size={21} />
            </button>
            <span>创作空间</span>
            <span className="crumb-divider">/</span>
            <strong>{name}</strong>
          </div>
          <div className="topbar-right">
            <button
              className="runtime-pill"
              onClick={() => navigate("settings")}
            >
              <span className="live-dot" />
              本地工作空间
            </button>
            <button className="user-pill" onClick={() => navigate("settings")}>
              <span>{user.name.slice(0, 1).toUpperCase()}</span>
              <b>{user.name}</b>
            </button>
            <button
              className="icon-button logout"
              aria-label="退出登录"
              title="退出登录"
              onClick={() =>
                void post("/auth/logout")
                  .then(onLogout)
                  .catch((e) => setToast(message(e)))
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {tools.error && (
            <ErrorPanel
              error={`工具目录读取失败：${tools.error}`}
              retry={tools.refresh}
            />
          )}
          <PageBoundary key={screenKey}>
            <Suspense fallback={<Loading />}>{content}</Suspense>
          </PageBoundary>
        </main>
        <footer className="app-footer">
          <span>CROSSCUT / 从灵感到成片</span>
          <span>媒体保存在本地 · AI 任务使用你配置的服务</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CircleDot size={17} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
function Auth({
  setup,
  onSuccess,
}: {
  setup: boolean;
  onSuccess: (user: User) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await post<{ user: User }>(
        `/auth/${setup ? "setup" : "login"}`,
        Object.fromEntries(data),
      );
      onSuccess(result.user);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <div className="brand">
          crosscut
          <Logo />
        </div>
        <div className="auth-story-main">
          <div className="eyebrow">THE NEXT FRAME IS YOURS</div>
          <h1>
            让每一份灵感，
            <br />
            都有一个
            <br />
            <em>精彩的下一帧。</em>
          </h1>
          <p>
            连接产品、故事与画面。
            <br />
            属于你的跨境广告创作空间。
          </p>
          <div className="auth-orbit" aria-hidden="true">
            <div />
            <div />
            <Sparkles size={82} strokeWidth={1} />
          </div>
        </div>
        <span className="small">独立部署 · SQLite 存储 · 真实媒体处理</span>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <span className="eyebrow">
            {setup ? "WELCOME TO YOUR STUDIO" : "WELCOME BACK"}
          </span>
          <h2>{setup ? "开启你的创作空间" : "继续你的下一次创作"}</h2>
          <p>
            {setup
              ? "创建本地管理员账号，素材与任务会保存在这台 Mac。"
              : "登录本地账号，接着上次的灵感继续。"}
          </p>
          {setup && (
            <label className="field">
              <span>你的名字</span>
              <input
                name="name"
                required
                maxLength={60}
                autoComplete="name"
                placeholder="怎么称呼你"
              />
            </label>
          )}
          <label className="field">
            <span>邮箱</span>
            <input
              name="email"
              required
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              name="password"
              required
              type="password"
              minLength={setup ? 10 : undefined}
              autoComplete={setup ? "new-password" : "current-password"}
              placeholder={setup ? "至少 10 位字符" : "输入你的密码"}
            />
          </label>
          {error && <ErrorPanel error={error} />}
          <button className="button primary full" disabled={busy}>
            {busy ? "正在处理…" : setup ? "创建创作空间" : "登录创作空间"}
            <ArrowRight size={17} />
          </button>
          <p className="auth-note">
            此账号独立于参考平台。外部 AI 服务可在进入后按需配置。
          </p>
        </form>
      </section>
    </div>
  );
}
function Logo() {
  return (
    <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true">
      <path
        fill="currentColor"
        d="M13 1h6v9l6-6 4 4-6 6h8v6h-8l6 6-4 4-6-6v8h-6v-8l-6 6-4-4 6-6H1v-6h8L3 8l4-4 6 6z"
      />
    </svg>
  );
}
