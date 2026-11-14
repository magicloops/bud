import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBrowserWaitActions, useOpenBrowserPane } from "@/features/browser/pane";
import type { ToolContentRendererProps } from "../types";

export function BrowserHandoffContent({ payload }: ToolContentRendererProps) {
  const open = useOpenBrowserPane();
  const actions = useBrowserWaitActions();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = payload.pending === true;
  const path = typeof payload.viewer_path === "string" &&
    /^\/browser\/browser_[0-9A-HJKMNP-TV-Z]{26}$/.test(payload.viewer_path)
    ? payload.viewer_path : null;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : path?.slice(9);
  const control = actions?.returnAction?.sessionId === sessionId ? actions?.returnAction : null;
  const browserVisible = Boolean(sessionId && actions?.visibleSessionId === sessionId);

  const handoff = sessionId ? actions?.handoffs?.[sessionId] : undefined;
  // Why the agent asked, while this is the session's open handoff.
  const reason = pending && handoff && (typeof payload.handoff_id !== "string" || payload.handoff_id === handoff.id)
    ? handoff.reason : null;

  return (
    <div className="space-y-2 text-sm">
      {!pending && <p>{typeof payload.summary === "string" ? payload.summary : "Browser handoff completed."}</p>}
      {reason && <p className="line-clamp-3 whitespace-pre-wrap">{reason}</p>}
      {/* The way out on the left, the action on the right (bud-mobile plan/chat-card-simplification.md, Phase 5W). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {pending && actions && typeof payload.invocation_id === "string" ? <Button type="button"
          variant="ghost" size="sm" disabled={stopping || control?.returning} onClick={async () => {
            if (stopping) return;
            setStopping(true); setError(null);
            try { await actions.stop(payload.invocation_id as string); }
            catch { setError("Could not cancel this run. Try again."); }
            finally { setStopping(false); }
          }}>{stopping ? "Canceling…" : "Cancel"}</Button> : <span />}
        <div className="flex flex-wrap items-center gap-2">
        {pending && control && <Button type="button" size="sm" variant="outline"
          className="border-2 border-green-600 bg-background font-mono font-semibold text-foreground shadow-[2px_2px_0_var(--color-green-600)] transition-transform hover:-translate-y-0.5 hover:bg-green-50 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none dark:border-green-400 dark:bg-background dark:shadow-[2px_2px_0_var(--color-green-400)] dark:hover:bg-green-950 motion-reduce:transform-none"
          disabled={!control || control.disabled || stopping} onClick={control?.run}
          title={!control ? "Take control in the browser pane before returning it to the agent." : undefined}>
          {control?.returning ? "Returning…" : "Return to agent"}
        </Button>}
        {path && (!browserVisible || (pending && !control)) && <Button variant="outline" size="sm" asChild>
          <a href={path} target="_blank" rel="noopener noreferrer" onClick={event => {
            if (open && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              open(path.slice(9));
            }
          }}>{pending && !control ? "Take control" : "Open browser"}</a>
        </Button>}
        </div>
      </div>
      {pending && actions?.error && actions.error.sessionId === sessionId && <p role="alert" className="text-destructive">{actions.error.message}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
