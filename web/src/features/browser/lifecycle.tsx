import { useEffect, useRef, useState } from "react";
import { apiFetchJson } from "@/lib/transport";

type Resource = { browser_id: string; revision: number; desired_state: string };

/** Bud-scoped controls, separate from closing this thread's tabs. */
export function BrowserLifecycle({ budId }: { budId: string }) {
  const [resource, setResource] = useState<Resource | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "reset" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/api/buds/${encodeURIComponent(budId)}/browser`;
  const currentBase = useRef(base);
  currentBase.current = base;
  useEffect(() => {
    setResource(null); setConfirm(null); setBusy(false); setError("");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await apiFetchJson<{ browser: Resource | null }>(base, { signal: abort.signal });
        if (!abort.signal.aborted) setResource(previous =>
          previous && data.browser && previous.browser_id === data.browser.browser_id && previous.revision > data.browser.revision ? previous : data.browser);
      } catch { /* Leave pending visible until acknowledged status is available. */ }
      if (!abort.signal.aborted) timer = setTimeout(() => void read(), 3000);
    };
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [base]);
  const send = async () => {
    if (!resource || !confirm || busy) return;
    setBusy(true); setError("");
    try {
      const next = await apiFetchJson<Resource>(`${base}/lifecycle`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: resource.revision, operation: confirm, confirmed: true }) });
      if (currentBase.current === base) {
        setResource(previous => previous && previous.browser_id === next.browser_id && previous.revision > next.revision ? previous : next);
        setConfirm(null);
      }
    } catch { if (currentBase.current === base) setError("Could not request this change. Refresh the status and try again."); }
    finally { if (currentBase.current === base) setBusy(false); }
  };
  if (!resource) return null;
  const pending = resource.desired_state.endsWith("_pending");
  const button = "rounded border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50";
  return <section className="mt-4 space-y-2 border-t border-border pt-3" aria-label="Shared browser data">
    <p className="text-xs text-muted-foreground">Website sign-ins are shared across this Bud’s threads and saved on this machine.</p>
    {pending ? <p role="status" className="text-sm">{resource.desired_state === "reset_pending" ? "Reset" : "Stop"} pending — waiting for Bud to confirm.</p>
      : confirm ? <>
        <p className="text-sm">{confirm === "reset" ? "Delete all saved website sign-ins, history and browser data on this Bud? This closes every thread’s browser tabs." : "Stop the browser for every thread? Saved website sign-ins and browser data will be kept."}</p>
        <button className={button} disabled={busy} onClick={() => void send()}>Confirm {confirm}</button>{" "}
        <button className={button} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
      </> : <div className="flex flex-wrap gap-2">
        <button className={button} disabled={resource.desired_state === "stopped"} onClick={() => setConfirm("stop")}>Stop Bud browser</button>
        <button className={button} onClick={() => setConfirm("reset")}>Reset browser data</button>
      </div>}
    {resource.desired_state === "stopped" && <p className="text-xs">Browser stopped. Ask Bud to open it again when ready.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
