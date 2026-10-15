import type { ReactNode } from "react";

type Item = Record<string, unknown>;
const record = (value: unknown): Item =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Item)
    : {};
const rows = (value: unknown): Item[] =>
  Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : "未知 / 抽样画面无法确认";
const stamp = (value: unknown) => {
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`
    : "未知";
};
function TextList({ label, value }: { label: string; value: unknown }) {
  const entries = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  if (!entries.length) return null;
  return (
    <section className="analysis-summary-block">
      <h3>{label}</h3>
      <ul>
        {entries.map((entry, i) => (
          <li key={i}>{entry}</li>
        ))}
      </ul>
    </section>
  );
}
export function AnalysisDetails({
  value,
  onSeek,
  fallback,
}: {
  value: unknown;
  onSeek: (start: number, end?: number) => void;
  fallback: ReactNode;
}) {
  const result = record(value);
  if (
    result.schemaVersion !== 2 ||
    (!Array.isArray(result.stages) && !Array.isArray(result.mechanisms))
  )
    return <>{fallback}</>;
  return (
    <div className="analysis-structured">
      <p className="prose-result">{text(result.summary)}</p>
      <p className="muted small">
        依据抽样画面作出的分析；未知信息保留未知，优化收益是建议目标，不是已验证的投放结果。
      </p>
      <TextList label="观察限制" value={result.limitations} />
      {Array.isArray(result.stages) ? (
        rows(result.stages).map((stage, i) => (
          <details className="analysis-stage" open key={i}>
            <summary>
              <span className="eyebrow">
                阶段 {String(i + 1).padStart(2, "0")}
              </span>
              <strong>{text(stage.title)}</strong>
              <span>
                {stamp(stage.start)} – {stamp(stage.end)}
              </span>
            </summary>
            <div className="analysis-stage-body">
              <button
                className="button secondary small-button"
                onClick={() => onSeek(Number(stage.start), Number(stage.end))}
              >
                播放这一阶段
              </button>
              <dl className="analysis-observations">
                <dt>阶段目的</dt>
                <dd>{text(stage.purpose)}</dd>
                <dt>内容</dt>
                <dd>{text(stage.content)}</dd>
              </dl>
              {rows(stage.shots).map((shot, j) => (
                <article className="analysis-shot" key={j}>
                  <button
                    className="text-button"
                    onClick={() => onSeek(Number(shot.start), Number(shot.end))}
                  >
                    镜头 {j + 1} · {stamp(shot.start)} – {stamp(shot.end)}
                  </button>
                  <p>{text(shot.description)}</p>
                  <dl className="analysis-observations">
                    {[
                      ["shotSize", "景别"],
                      ["angle", "视角"],
                      ["action", "动作"],
                      ["onScreenText", "屏幕文字"],
                      ["textTranslation", "文字释义"],
                    ].map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>
                          {shot[key] === "" &&
                          ["onScreenText", "textTranslation"].includes(key)
                            ? "未见可读文字"
                            : text(shot[key])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          </details>
        ))
      ) : (
        <>
          <div className="analysis-diagnosis">
            <TextList label="核心优势" value={result.strengths} />
            <TextList label="关键短板" value={result.weaknesses} />
            <TextList label="优先动作" value={result.priorityActions} />
          </div>
          {rows(result.mechanisms).map((mechanism, i) => (
            <article className="mechanism-card" key={i}>
              <span className="eyebrow">
                机制 {String(i + 1).padStart(2, "0")}
              </span>
              <h3>{text(mechanism.name)}</h3>
              <p>{text(mechanism.summary)}</p>
              <div className="analysis-goals">
                {Array.isArray(mechanism.goals) &&
                  mechanism.goals.map((goal, j) => (
                    <span key={j}>{String(goal)}</span>
                  ))}
              </div>
              <h4>镜头证据</h4>
              <div className="analysis-evidence">
                {rows(mechanism.evidence).map((evidence, j) => (
                  <div key={j}>
                    <button
                      className="text-button"
                      onClick={() =>
                        onSeek(Number(evidence.start), Number(evidence.end))
                      }
                    >
                      {stamp(evidence.start)} – {stamp(evidence.end)}
                    </button>
                    <p>{text(evidence.description)}</p>
                  </div>
                ))}
              </div>
              <dl className="analysis-observations">
                {[
                  ["principle", "作用原理"],
                  ["problem", "问题与限制"],
                  ["action", "具体行动"],
                  ["expectedBenefit", "预期改善 · 尚待验证"],
                ].map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{text(mechanism[key])}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </>
      )}
    </div>
  );
}
