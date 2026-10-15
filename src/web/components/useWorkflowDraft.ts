import { useCallback, useEffect, useRef, useState } from "react";
import type { Draft } from "../../shared/types";
import { message, post } from "../api";
import { workflowInput, type WorkflowState } from "../workflow-state";

export function useWorkflowDraft(
  draft: Draft,
  initial: WorkflowState,
  onSaved: (draft: Draft) => void,
) {
  const [state, setState] = useState(initial);
  const [status, setStatus] = useState<
    "saved" | "pending" | "saving" | "error"
  >("saved");
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState(draft.updatedAt);
  const current = useRef(initial);
  const saved = useRef(JSON.stringify(initial));
  const inFlight = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;

  const update = useCallback(
    (change: (previous: WorkflowState) => WorkflowState) => {
      const next = change(current.current);
      if (JSON.stringify(next) === JSON.stringify(current.current)) return;
      current.current = next;
      setState(next);
      setStatus("pending");
      setError("");
    },
    [],
  );

  // One request at a time: a slower earlier save can never overwrite a newer
  // stage. Changes made during a request are saved in the same queue afterward.
  const save = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const persist = async () => {
      try {
        while (saved.current !== JSON.stringify(current.current)) {
          const snapshot = current.current;
          const serialized = JSON.stringify(snapshot);
          if (mounted.current) setStatus("saving");
          const result = await post<Draft>("/drafts", {
            id: draft.id,
            toolId: `workflow-${snapshot.flow}`,
            title: snapshot.title,
            projectId: null,
            input: workflowInput(snapshot),
          });
          saved.current = serialized;
          if (mounted.current) {
            setSavedAt(result.updatedAt);
            savedCallback.current(result);
          }
        }
        if (mounted.current) {
          setStatus("saved");
          setError("");
        }
        return true;
      } catch (failure) {
        if (mounted.current) {
          setStatus("error");
          setError(`工作流尚未保存：${message(failure)}`);
        }
        return false;
      }
    };
    const request = persist();
    inFlight.current = request;
    void request.finally(() => {
      inFlight.current = null;
    });
    return request;
  }, [draft.id]);

  useEffect(() => {
    if (saved.current === JSON.stringify(state)) return;
    const timer = window.setTimeout(() => void save(), 350);
    return () => window.clearTimeout(timer);
  }, [state, save]);

  useEffect(() => {
    mounted.current = true;
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (saved.current === JSON.stringify(current.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => {
      window.removeEventListener("beforeunload", warnUnsaved);
      // A normal in-app route change retains the authenticated save request.
      // Refresh/closing while dirty uses the native unsaved-changes prompt.
      mounted.current = false;
      void save();
    };
  }, [save]);

  return { state, update, save, status, error, savedAt };
}
