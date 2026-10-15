import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw, Square } from "lucide-react";
import type { Job, JobStatus } from "../../shared/types";
import { message, post, useQuery } from "../api";
import { useWorkspace } from "../context";
import { ErrorPanel } from "../ui";

interface Batch {
  id: string;
  total: number;
  counts: Record<JobStatus, number>;
  outputCount: number;
}

export function BatchSummary({
  jobs,
  onChanged,
}: {
  jobs: Job[];
  onChanged: () => void;
}) {
  const { notify } = useWorkspace();
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ id: string; message: string }[]>(
    [],
  );
  const id = jobs[0].batchId;
  const signature = jobs.map((job) => `${job.id}:${job.updatedAt}`).join("|");
  const previous = useRef(signature);
  const result = useQuery<Batch | null>(`/batches/${id}`, null, 15000);
  useEffect(() => {
    if (signature !== previous.current) {
      previous.current = signature;
      result.refresh();
    }
  }, [signature, result.refresh]);
  async function act(operation: "cancel" | "retry") {
    setBusy(operation);
    setError("");
    setFailures([]);
    try {
      const response = await post<{
        items: Job[];
        errors: { id: string; message: string }[];
      }>(`/batches/${id}/${operation}`);
      setFailures(response.errors);
      result.refresh();
      onChanged();
      notify(
        operation === "cancel"
          ? `已处理 ${response.items.length} 项取消请求${response.errors.length ? `，${response.errors.length} 项未完成` : ""}`
          : `已提交 ${response.items.length} 项失败重试${response.errors.length ? `，${response.errors.length} 项未完成` : ""}`,
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(null);
    }
  }
  const batch = result.data;
  if (result.error)
    return (
      <p className="small muted" role="status">
        批次 {id.slice(0, 8)} 的完整状态暂不可用：{result.error}
      </p>
    );
  if (!batch || batch.total <= 1) return null;
  return (
    <section className="batch-group" aria-label={`批次 ${id.slice(0, 8)}`}>
      <div className="batch-summary">
        <span>
          批次 {id.slice(0, 8)} · 共 {batch.total} 项
        </span>
        <strong>{batch.counts.succeeded} 已完成</strong>
        <span>{batch.counts.queued + batch.counts.running} 处理中</span>
        {batch.counts.failed > 0 && <span>{batch.counts.failed} 失败</span>}
        {batch.counts.cancelled > 0 && (
          <span>{batch.counts.cancelled} 已取消</span>
        )}
        {batch.counts.needs_review > 0 && (
          <span>{batch.counts.needs_review} 待核对</span>
        )}
        <div className="actions">
          {batch.counts.queued + batch.counts.running > 0 && (
            <button
              type="button"
              className="button secondary small-button"
              disabled={!!busy}
              onClick={() => void act("cancel")}
            >
              <Square size={13} />
              {busy === "cancel" ? "正在请求取消…" : "取消未完成"}
            </button>
          )}
          {batch.counts.failed > 0 && (
            <button
              type="button"
              className="button secondary small-button"
              disabled={!!busy}
              onClick={() => void act("retry")}
            >
              <RefreshCw size={14} />
              {busy === "retry" ? "正在提交…" : "重试失败项"}
            </button>
          )}
          {batch.outputCount > 0 && (
            <a
              className="button secondary small-button"
              href={`/api/batches/${id}/download`}
              title="下载这个批次目前已生成的全部产物，包含其他分页中的任务"
            >
              <ArrowDownToLine size={15} /> 整批下载 · {batch.outputCount} 份
            </a>
          )}
        </div>
      </div>
      {error && <ErrorPanel error={error} />}
      {failures.length > 0 && (
        <div className="batch-errors" role="alert">
          <strong>部分任务未能完成操作，已成功作品仍保留。</strong>
          <ul>
            {failures.map((failure) => (
              <li key={failure.id}>
                <span>
                  {jobs.find((job) => job.id === failure.id)?.title ??
                    `任务 ${failure.id.slice(0, 8)}`}
                </span>
                ：{failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
