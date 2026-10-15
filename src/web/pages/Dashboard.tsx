import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Clapperboard,
  Compass,
  FolderPlus,
  Layers3,
  Play,
  Scissors,
  Sparkles,
} from "lucide-react";
import type { Job, Project } from "../../shared/types";
import { bytes, navigate, useQuery } from "../api";
import { useWorkspace } from "../context";
import {
  Availability,
  Empty,
  ErrorPanel,
  JobPanel,
  JobRow,
  Loading,
  PageTitle,
} from "../ui";

interface Overview {
  projects: number;
  assets: number;
  jobs: number;
  completed: number;
  recentJobs: Job[];
  recentProjects: Project[];
  capabilities: { local: number; configured: number; total: number };
  storageBytes: number;
}
export function Dashboard() {
  const { user, tools } = useWorkspace();
  const [job, setJob] = useState<string | null>(null);
  const overview = useQuery<Overview | null>("/overview", null, 10000);
  return (
    <>
      <PageTitle
        eyebrow="YOUR CREATIVE SPACE"
        title={`${user.name}，让创意继续发生。`}
        description="研究灵感，整理素材，把下一条广告变成作品。"
        actions={
          <button className="button primary" onClick={() => navigate("studio")}>
            <Sparkles size={17} />
            开始创作
          </button>
        }
      />
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">FROM FIRST SPARK TO FINAL CUT</span>
          <h2>
            一份好素材，
            <br />
            不止一种可能<span>。</span>
          </h2>
          <p>
            把产品的亮点，变成值得停留的画面。
            <br />
            从一段故事开始，接上你的下一次创作。
          </p>
          <button
            className="button lime"
            onClick={() => navigate("studio", { tool: "video-studio" })}
          >
            进入视频工作室 <ArrowUpRight size={18} />
          </button>
          <div className="hero-caption">
            <span />
            <span />
            文字 · 图像 · 视频 · 声音
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <svg viewBox="0 0 500 330">
            <defs>
              <linearGradient id="cardGlow" x2="1" y2="1">
                <stop stopColor="#b1c98b" />
                <stop offset="1" stopColor="#5c806a" />
              </linearGradient>
              <linearGradient id="bottleGlow" x2="1" y2="1">
                <stop stopColor="#f4e5c9" />
                <stop offset="1" stopColor="#c49d71" />
              </linearGradient>
              <filter id="cardShadow">
                <feDropShadow
                  dx="0"
                  dy="14"
                  stdDeviation="10"
                  floodOpacity=".12"
                />
              </filter>
            </defs>
            <circle
              cx="270"
              cy="160"
              r="136"
              fill="none"
              stroke="#cad7be"
              strokeDasharray="3 9"
            />
            <circle cx="270" cy="160" r="103" fill="none" stroke="#cad7be" />
            <g
              transform="translate(45 88) rotate(-13 70 98)"
              filter="url(#cardShadow)"
            >
              <rect width="145" height="204" rx="17" fill="white" />
              <rect
                x="8"
                y="8"
                width="129"
                height="160"
                rx="10"
                fill="#cecbb6"
              />
              <path d="M8 140Q56 83 137 113V168H8Z" fill="#7b9871" />
              <path d="M8 134Q50 158 137 101V168H8Z" fill="#506f54" />
              <circle cx="107" cy="41" r="16" fill="#fff0be" />
              <rect
                x="17"
                y="180"
                width="64"
                height="5"
                rx="2"
                fill="#bdc5b4"
              />
              <rect
                x="17"
                y="190"
                width="37"
                height="4"
                rx="2"
                fill="#e3e7de"
              />
            </g>
            <g
              transform="translate(185 35) rotate(5 83 125)"
              filter="url(#cardShadow)"
            >
              <rect width="165" height="258" rx="18" fill="white" />
              <rect
                x="8"
                y="8"
                width="149"
                height="213"
                rx="12"
                fill="url(#cardGlow)"
              />
              <ellipse cx="85" cy="190" rx="55" ry="15" fill="#365a4140" />
              <path d="M22 149Q18 83 47 53Q64 111 22 149Z" fill="#d8e9b6" />
              <path
                d="M119 172Q164 98 126 48Q100 104 119 172Z"
                fill="#d8e9b6"
              />
              <rect
                x="53"
                y="71"
                width="62"
                height="123"
                rx="17"
                fill="url(#bottleGlow)"
              />
              <rect
                x="63"
                y="57"
                width="42"
                height="28"
                rx="7"
                fill="#274c39"
              />
              <rect
                x="60"
                y="118"
                width="48"
                height="37"
                rx="2"
                fill="#f7f0d8"
              />
              <path
                d="M77 129h16M72 138h25M80 146h10"
                stroke="#536345"
                strokeWidth="2"
              />
              <rect
                x="18"
                y="235"
                width="91"
                height="5"
                rx="2"
                fill="#bdc5b4"
              />
              <circle cx="141" cy="237" r="9" fill="#d8f58b" />
              <path d="m139 233 5 4-5 4Z" fill="#284333" />
            </g>
            <g
              transform="translate(351 125) rotate(13 63 78)"
              filter="url(#cardShadow)"
            >
              <rect width="126" height="157" rx="15" fill="#17382d" />
              <path
                d="M22 58v34M35 39v71M48 58v33M61 23v100M74 47v54M87 36v78M100 59v34"
                stroke="#d8f58b"
                strokeWidth="6"
                strokeLinecap="round"
              />
              <rect
                x="17"
                y="135"
                width="62"
                height="4"
                rx="2"
                fill="#719c7d"
              />
            </g>
            <g fill="#284c39">
              <path d="m116 37 4 12 12 4-12 4-4 12-4-12-12-4 12-4z" />
              <path d="m402 67 3 9 9 3-9 3-3 9-3-9-9-3 9-3z" />
            </g>
          </svg>
          <div className="art-label">
            <Play size={12} fill="currentColor" />
            下一帧，由你定义
          </div>
        </div>
      </section>
      {overview.error && (
        <ErrorPanel error={overview.error} retry={overview.refresh} />
      )}
      <section className="stats">
        {[
          {
            label: "创作项目",
            value: overview.data?.projects,
            icon: FolderPlus,
          },
          { label: "素材库存", value: overview.data?.assets, icon: Layers3 },
          {
            label: "已完成作品",
            value: overview.data?.completed,
            icon: Clapperboard,
          },
          {
            label: "本地存储",
            value: overview.data
              ? bytes(overview.data.storageBytes)
              : undefined,
            icon: ArrowDownToLine,
          },
        ].map((stat) => (
          <div className="stat" key={stat.label}>
            <div>
              <span>{stat.label}</span>
              <strong>{stat.value ?? "—"}</strong>
            </div>
            <stat.icon size={22} strokeWidth={1.4} />
          </div>
        ))}
      </section>
      <div className="section-heading">
        <div>
          <h2>今天，你想从哪里开始？</h2>
          <p>选择一条适合你的创作路径</p>
        </div>
        <a href="#studio">
          全部工具 <ArrowRight size={16} />
        </a>
      </div>
      <div className="path-grid">
        {[
          {
            title: "让画面动起来",
            detail: "用文字、图片和参考素材，构建视频的第一帧。",
            tool: "video-studio",
            icon: Clapperboard,
            accent: "sage",
            link: "图文生视频",
          },
          {
            title: "让素材组合起来",
            detail: "为已有镜头编排节奏，批量剪出新的表达。",
            tool: "remix",
            icon: Scissors,
            accent: "sand",
            link: "批量混剪",
          },
          {
            title: "看懂一条好广告",
            detail: "拆开镜头与叙事，把灵感转化成创作依据。",
            tool: "analysis",
            icon: Compass,
            accent: "lavender",
            link: "开始视频拆解",
          },
        ].map((card) => (
          <button
            key={card.tool}
            className={`path-card ${card.accent}`}
            onClick={() =>
              navigate(
                card.tool === "analysis" ? "analysis" : "studio",
                card.tool !== "analysis" ? { tool: card.tool } : {},
              )
            }
          >
            <span className="path-icon">
              <card.icon size={24} strokeWidth={1.5} />
            </span>
            <h3>{card.title}</h3>
            <p>{card.detail}</p>
            <div>
              <strong>{card.link}</strong>
              <ArrowUpRight size={18} />
            </div>
          </button>
        ))}
      </div>
      <div className="dashboard-bottom">
        <section className="panel">
          <div className="section-heading">
            <h2>最近的创作</h2>
            <a href="#tasks">
              查看全部 <ArrowRight size={15} />
            </a>
          </div>
          {overview.loading && !overview.data ? (
            <Loading />
          ) : overview.data?.recentJobs.length ? (
            overview.data.recentJobs
              .slice(0, 5)
              .map((item) => (
                <JobRow
                  key={item.id}
                  job={item}
                  onClick={() => setJob(item.id)}
                />
              ))
          ) : (
            <Empty
              icon={Clapperboard}
              title="第一件作品，值得期待"
              detail="开始一项创作，真实进度与结果会出现在这里。"
            />
          )}
        </section>
        <section className="panel capability-panel">
          <span className="eyebrow">READY WHEN YOU ARE</span>
          <h2>让工具准备就绪</h2>
          <p>本地后期可直接运行。配置你自己的 AI 服务，即可扩展创作能力。</p>
          <div className="capability-summary">
            <strong>{overview.data?.capabilities.local ?? "—"}</strong>
            <span>项本地能力</span>
            <strong>{overview.data?.capabilities.configured ?? "—"}</strong>
            <span>项服务已配置</span>
          </div>
          <div className="capability-list">
            {tools
              .filter((tool) =>
                ["remix", "image-generate", "text-video"].includes(tool.id),
              )
              .map((tool) => (
                <div key={tool.id}>
                  <span>{tool.title}</span>
                  <Availability tool={tool} />
                </div>
              ))}
          </div>
          <button
            className="button secondary full"
            onClick={() => navigate("settings")}
          >
            管理模型服务 <ArrowUpRight size={16} />
          </button>
        </section>
      </div>
      <JobPanel id={job} onClose={() => setJob(null)} />
    </>
  );
}
