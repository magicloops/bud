import { BrowserLifecycle } from "./lifecycle";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetchJson, buildAbsoluteApiUrl, isApiError } from "@/lib/transport";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { enqueueInput, inputMatchesFrame, type QueuedInput } from "./input-queue";
import { ViewportFitter } from "./viewport-fit";
import { BrowserCanvas, type BrowserFrame } from "./media";

type Session = {
  session_id: string;
  thread_id: string;
  bud_id: string;
  generation: string;
  state: string;
  control_state: string;
  control_epoch?: number;
  revision: number;
  can_view: boolean;
  runtime_status?: "available" | "disconnected" | "daemon_restarted" | "ended";
  can_resize_viewport?: boolean;
  can_resize_agent_viewport?: boolean;
  can_capture_hidpi?: boolean;
  can_navigate_history?: boolean;
  can_take_control?: boolean;
  can_show_window?: boolean;
  owns_control?: boolean;
  recovery_ticket?: string;
  page_recovery?: { restored_pages: number; hints_available: boolean };
  handoff?: { reason: string } | null;
};
const button =
  "rounded border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50";
const controlErrors: Record<string, string> = {
  browser_window_unsupported: "Native window controls are unavailable on this Bud.",
  browser_window_unconfirmed: "The browser window change was not confirmed. Browser work remains private. Try Hide browser window before returning to the agent.",
  browser_recovery_unavailable: "Saved pages could not be restored. Take control to inspect the workspace; saved sign-ins remain.",
  browser_recovery_uncertain: "Page reopening was not confirmed and has not been retried. Take control to inspect the browser; some pages may have opened.",
  browser_revision_conflict: "Browser status changed. Wait for status to refresh, then try again.",
  browser_controller_exists: "Another viewer has control. Pause it there or close it and wait for its control lease to expire.",
  browser_control_expired: "Private control expired. Take control again to reconnect.",
  browser_stale_request: "Bud rejected an outdated browser request. Take control again to establish a fresh control session.",
  browser_stale_control: "Bud rejected an outdated control version. Take control again.",
  browser_control_conflict: "Bud's browser control state changed. Take control again.",
  browser_stale_connection: "The Bud connection changed. Wait for it to reconnect, then take control again.",
  browser_closed: "The browser was closed. Return to the conversation to open another.",
  browser_handoff_unavailable: "The browser runtime is disconnected, restarted, or does not support handoff. Check that the correct Bud is running.",
  browser_control_uncertain: "Bud did not confirm the control transition. The browser remains paused.",
  browser_busy: "The browser is processing another request. Please try again shortly.",
  browser_agent_still_running: "The agent has not finished pausing. Please try again shortly.",
  browser_interrupted: "This browser session was interrupted. Ask the agent to open the page again, or take control.",
  browser_not_found: "This browser session is no longer available. Return to the conversation.",
};

export type BrowserReturnAction = {
  sessionId: string;
  disabled: boolean;
  returning: boolean;
  run: () => void;
};

export function BrowserViewer({ sessionId, embedded = false, onDismiss, onReturnActionChange, onControlErrorChange }: { sessionId: string; embedded?: boolean; onDismiss?: () => void; onReturnActionChange?: (action: BrowserReturnAction | null) => void; onControlErrorChange?: (error: { sessionId: string; message: string } | null) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  useEffect(() => {
    const message = error || statusError;
    onControlErrorChange?.(message ? {sessionId, message} : null);
    return () => onControlErrorChange?.(null);
  }, [error,statusError,sessionId,onControlErrorChange]);
  const [notice, setNotice] = useState("");
  const [empty, setEmpty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [owns, setOwns] = useState(false);
  const [takeoverPending, setTakeoverPending] = useState(false);
  const [working, setWorking] = useState(false);
  const [returning, setReturning] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryTicket = useRef<string | null>(null);
  const recoveryPending = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recoveryOptionsOpen, setRecoveryOptionsOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState(true);
  const [resizing, setResizing] = useState(false);
  const resizeBlocked = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const frameReady = useRef<((frame: BrowserFrame) => void) | null>(null);
  const ownsRef = useRef(false);
  const changingControl = useRef(false);
  const controlVersion = useRef(0);
  const failurePriority = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [connected, setConnected] = useState(false);
  const [targets, setTargets] = useState<BrowserFrame["targets"]>([]);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [mediaVersion, setMediaVersion] = useState(0);
  const viewerId = useRef(crypto.randomUUID());
  const canvas = useRef<HTMLCanvasElement>(null);
  const media = useRef<BrowserCanvas | null>(null);
  const mounted = useRef(true);
  const focus = useRef<string | null>(null);
  const inputEpoch = useRef(0);
  const queue = useRef<QueuedInput[]>([]);
  const sending = useRef(false);
  const renewing = useRef(false);
  const typing = useRef<HTMLTextAreaElement>(null);
  const base = `/api/browser/sessions/${encodeURIComponent(sessionId)}`;
  const resetInput = useCallback(() => {
    inputEpoch.current++;
    queue.current = [];
    focus.current = null;
    if (typing.current) typing.current.value = "";
  }, []);
  const failPrivate = useCallback((message: string, priority: number, recover = false) => {
    if (!mounted.current) return;
    if (priority > failurePriority.current) {
      failurePriority.current = priority;
      setError(message);
    }
    const wasOwner = ownsRef.current;
    if (!recover) recoveryTicket.current = null;
    recoveryPending.current = recover && !!recoveryTicket.current;
    setRecovering(recoveryPending.current);
    ownsRef.current = false;
    setOwns(false);
    resetInput();
    media.current?.close();
    // Release is a privacy fence, never a return or replay of page input.
    if (wasOwner && sessionRef.current && !recoveryPending.current)
      void apiFetchJson(`${base}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "release", revision: sessionRef.current.revision, viewer_id: viewerId.current }) }).catch(() => {});
  }, [base, resetInput]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryTicket.current = null;
      recoveryPending.current = false;
      resetInput();
    };
  }, [resetInput]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const version = controlVersion.current;
        const data = await apiFetchJson<Session>(`${base}?viewer_id=${encodeURIComponent(viewerId.current)}`, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          setStatusError("");
          setMissing(false);
          setSession((previous) =>
            previous && previous.revision > data.revision ? previous : data,
          );
          if (version === controlVersion.current && !changingControl.current && ownsRef.current &&
              data.owns_control === false && data.revision >= (sessionRef.current?.revision ?? 0))
            failPrivate("Browser control was lost. Take control again to reconnect; the agent remains paused.", 1, true);
          if (recoveryPending.current && !changingControl.current && !ownsRef.current && data.runtime_status === "available")
            void latestControl.current("recover");
        }
      } catch (failure) {
        if (!abort.signal.aborted && isApiError(failure) && failure.message === "browser_not_found") {
          setMissing(true);
          return;
        }
        if (!abort.signal.aborted)
          setStatusError("Could not refresh browser status. Reconnecting…");
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void read(), 3000);
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, failPrivate]);
  const control = useCallback(
    async (operation: "acquire" | "return" | "release" | "renew" | "close" | "recover" | "reopen" | "show_window" | "hide_window") => {
      if (!session) return;
      if (changingControl.current) return;
      if (operation === "recover" && !recoveryTicket.current) return;
      if (operation !== "recover" && operation !== "renew") {
        recoveryTicket.current = null;
        recoveryPending.current = false;
        setRecovering(false);
      }
      if (operation === "renew") {
        if (renewing.current || !ownsRef.current) return;
        renewing.current = true;
      }
      if (operation !== "renew" && mounted.current) {
        controlVersion.current++;
        changingControl.current = true;
        failurePriority.current = 0;
        setError("");
        setNotice("");
        setWorking(true);
        setReturning(operation === "return");
        resetInput();
      }
      let returnLease: Session | undefined;
      try {
        let revision = session.revision;
        // Explicit Return may recover a lease lost during takeover/restart.
        // Existing acquire authorization and competing-controller checks still apply.
        if (operation === "return" && !ownsRef.current) {
          const acquired = await apiFetchJson<Session>(`${base}/control`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operation: "acquire", revision, viewer_id: viewerId.current }),
          });
          if (acquired.control_state !== "human_private") throw new Error("Control acquisition not confirmed");
          if (!mounted.current) {
            void apiFetchJson(`${base}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ operation: "release", revision: acquired.revision, viewer_id: viewerId.current }) }).catch(() => {});
            return;
          }
          returnLease = acquired;
          revision = acquired.revision;
        }
        const data = await apiFetchJson<Session>(`${base}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation,
            ...(operation === "show_window" && selectedTarget ? { target_id: selectedTarget } : {}),
            revision,
            viewer_id: viewerId.current,
            ...(operation === "recover" ? { recovery_ticket: recoveryTicket.current } : {}),
          }),
        });
        if (!mounted.current) {
          if ((operation === "acquire" || operation === "recover" || operation === "reopen" || operation === "show_window" || operation === "hide_window") && data.control_state === "human_private")
            void apiFetchJson(`${base}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ operation: "release", revision: data.revision, viewer_id: viewerId.current }) }).catch(() => {});
          return;
        }
        if (operation === "renew" && !ownsRef.current) return;
        if (data.page_recovery) setNotice(!data.page_recovery.hints_available
          ? "Saved pages could not be read. Your saved sign-ins remain; the workspace is ready."
          : data.page_recovery.restored_pages === 0 ? "No saved pages were available. Your saved sign-ins remain; the workspace is ready." : "");
        if (data.recovery_ticket) recoveryTicket.current = data.recovery_ticket;
        setSession(previous => previous && previous.revision > data.revision ? previous : ({
          ...data,
          handoff: data.handoff === undefined ? previous?.handoff : data.handoff,
        }));
        if (!failurePriority.current) setError("");
        if (operation !== "renew") {
          const acquired =
            (operation === "acquire" || operation === "recover" || operation === "reopen" || operation === "show_window" || operation === "hide_window") && data.control_state === "human_private";
          const keptPrivateMedia = ownsRef.current && acquired && (operation === "show_window" || operation === "hide_window");
          ownsRef.current = acquired;
          setOwns(acquired);
          recoveryPending.current = false;
          setRecovering(false);
          setTakeoverPending(operation === "acquire" && !acquired);
          if (!keptPrivateMedia) setMediaVersion((v) => v + 1);
        }
      } catch (failure) {
        // A failed compound return must not leave an invisible renewable owner.
        // Release only pauses; it never retries the return or resumes the agent.
        if (returnLease) {
          await apiFetchJson(`${base}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operation: "release", revision: returnLease.revision, viewer_id: viewerId.current }) }).catch(() => {});
        }
        if (!mounted.current || (operation === "renew" && !ownsRef.current)) return;
        const code = isApiError(failure) ? failure.message : "";
        if ((operation === "renew" || operation === "recover") && recoveryTicket.current &&
            (!code || ["browser_control_expired", "browser_control_uncertain", "browser_unavailable",
              "browser_handoff_unavailable", "browser_stale_connection", "browser_busy", "browser_agent_still_running"].includes(code))) {
          failPrivate("Reconnecting your private browser view…", 1, true);
          return;
        }
        if (code === "browser_window_unconfirmed") {
          failurePriority.current = 2;
          setError(`${controlErrors[code]} (${operation})`);
          // Show may have acquired private control before its window operation
          // failed. Resolve ownership rather than losing the renewable lease.
          try {
            const current = await apiFetchJson<Session>(`${base}?viewer_id=${encodeURIComponent(viewerId.current)}`);
            if (mounted.current) {
              setSession(previous => previous && previous.revision > current.revision ? previous : current);
              ownsRef.current = current.owns_control === true;
              setOwns(ownsRef.current);
            }
          } catch { /* Keep the window-specific failure visible. */ }
          return;
        }
        recoveryTicket.current = null;
        recoveryPending.current = false;
        setRecovering(false);
        setError(
          controlErrors[code]
            ? `${controlErrors[code]} (${code}; ${operation})`
            : "Could not confirm control. Check the connection and try again.",
        );
        ownsRef.current = false;
        setOwns(false);
        setTakeoverPending(false);
        resetInput();
        media.current?.close();
      } finally {
        if (operation === "renew") renewing.current = false;
        if (operation !== "renew") {
          controlVersion.current++;
          changingControl.current = false;
        }
        if (mounted.current && operation !== "renew") {
          setWorking(false);
          setReturning(false);
        }
      }
    },
    [base, session, selectedTarget, resetInput, failPrivate],
  );
  const latestControl = useRef(control);
  useEffect(() => {
    latestControl.current = control;
  }, [control]);
  useEffect(() => {
    if (takeoverPending && session?.can_take_control && !working)
      void control("acquire");
  }, [takeoverPending, session?.can_take_control, working, control]);
  useEffect(() => {
    if (!owns) return;
    const timer = setInterval(() => void latestControl.current("renew"), 5000);
    return () => clearInterval(timer);
  }, [owns]);
  useEffect(() => () => {
    if (ownsRef.current) void latestControl.current("release");
  }, []);
  const ended = missing || session?.runtime_status === "daemon_restarted" || session?.runtime_status === "ended" || session?.state === "closing" || session?.state === "interrupted";
  const canReturn = !missing && ((owns && !ended) || (session?.can_take_control === true &&
    ["paused", "human_private", "resume_pending"].includes(session.control_state)));
  useEffect(() => {
    onReturnActionChange?.(canReturn ? {
      sessionId,
      disabled: working || (owns && resizing),
      returning,
      run: () => {
        const current = sessionRef.current;
        const recoverable = current?.can_take_control && ["paused", "human_private", "resume_pending"].includes(current.control_state);
        if ((ownsRef.current ? !resizeBlocked.current : recoverable) && !changingControl.current)
          void latestControl.current("return");
      },
    } : null);
    return () => onReturnActionChange?.(null);
  }, [onReturnActionChange, canReturn, owns, sessionId, working, resizing, returning]);
  useEffect(() => {
    if (!ended) return;
    recoveryTicket.current = null;
    recoveryPending.current = false;
    setRecovering(false);
    ownsRef.current = false;
    setOwns(false);
    setTakeoverPending(false);
    resetInput();
    setTargets([]);
    setSelectedTarget("");
  }, [ended, resetInput]);
  const canView = !ended && (session?.can_view || owns);
  // Fitting follows invocation epochs even while the passive canvas survives.
  const passiveEpoch = owns ? undefined : session?.control_epoch;
  // Agent media ignores invocation epochs. Fitting still fences
  // using passiveEpoch; private/paused transitions retain their own identity.
  const mediaEpoch = !owns && session?.control_state === "agent"
    ? "agent-continuity" : passiveEpoch;
  useEffect(() => {
    setConnected(false);
    setEmpty(false);
    resetInput();
    if (!canView || !canvas.current) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const url = new URL(buildAbsoluteApiUrl(`${base}/media`));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const client = new BrowserCanvas(
      canvas.current,
      url.toString(),
      viewerId.current,
      (state, list) => {
        if (!mounted.current || media.current !== client) return;
        setConnected(state === "connected");
        setEmpty(state === "empty");
        if (state === "empty") { resetInput(); resizeBlocked.current = false; setResizing(false); }
        if (state === "connected" && client.frame) frameReady.current?.(client.frame);
        if (state === "unavailable") {
          resetInput();
          setTargets([]);
          setSelectedTarget("");
          if (ownsRef.current && !changingControl.current)
            failPrivate("Browser view was lost. Private control is paused; take control again to reconnect.", 1, true);
          else if (!ownsRef.current && !changingControl.current)
            retry = setTimeout(() => {
              if (mounted.current && media.current === client) setMediaVersion(v => v + 1);
            }, 3000);
        }
        if (list) {
          setTargets((previous) =>
            JSON.stringify(previous) === JSON.stringify(list) ? previous : list,
          );
          setSelectedTarget(client.frame?.target_id ?? "");
        }
      },
      () => sessionRef.current?.can_capture_hidpi ? Math.max(1, Math.min(2, window.devicePixelRatio || 1)) : undefined,
    );
    media.current = client;
    return () => {
      clearTimeout(retry);
      if (media.current === client) media.current = null;
      client.close();
    };
  }, [base, canView, mediaVersion, session?.generation, mediaEpoch, owns, resetInput, failPrivate]);
  useEffect(() => {
    const permitted = owns ? session?.can_resize_viewport : session?.control_state === "agent" && session?.can_resize_agent_viewport;
    if (ended || !fit || !permitted || !connected || !selectedTarget || !surface.current) return;
    const abort = new AbortController();
    const fitter = new ViewportFitter(async (size) => {
      resizeBlocked.current = true;
      setResizing(true);
      resetInput();
      try {
        const deadline = Date.now() + 5000;
        while ((sending.current || renewing.current) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
          abort.signal.throwIfAborted();
        }
        if (sending.current || renewing.current) throw new Error("controller busy");
        const frame = media.current?.frame;
        if (!frame || frame.target_id !== selectedTarget) throw new Error("page changed");
        const result = await apiFetchJson<{ viewport_id: string }>(`${base}/viewport`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
          body: JSON.stringify({ ...size, viewer_id: viewerId.current, target_id: frame.target_id, document_id: frame.document_id }),
        });
        abort.signal.throwIfAborted();
        // Passive fitting has no input to fence; the agent may navigate before
        // the next frame. Do not wait for an obsolete document in that case.
        if (!owns) { resizeBlocked.current = false; return; }
        // An ACK alone is not proof that the displayed pixels use the new coordinates.
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", cancelled);
            if (frameReady.current === check) frameReady.current = null;
            if (error) reject(error); else resolve();
          };
          const cancelled = () => finish(new Error("cancelled"));
          const check = (next: BrowserFrame) => {
            if (next.target_id === frame.target_id && next.document_id === frame.document_id && next.viewport_id === result.viewport_id) finish();
          };
          const timer = setTimeout(() => finish(new Error("frame timeout")), 5000);
          frameReady.current = check;
          abort.signal.addEventListener("abort", cancelled, { once: true });
          if (media.current?.frame) check(media.current.frame);
        });
        if (!abort.signal.aborted) resizeBlocked.current = false;
      } finally {
        if (!abort.signal.aborted) setResizing(false);
      }
    }, () => {
      if (!abort.signal.aborted) {
        if (owns) failPrivate("Page resizing was not confirmed. Private control is paused; take control again before interacting.", 2);
        else {
          resizeBlocked.current = false;
          setFit(false);
          setError("Pane fitting was not applied. Another viewer may be sizing the page, or the page changed. Enable Fit pane to try again; the agent can continue.");
        }
      }
    });
    const element = surface.current;
    const measure = () => { const bounds = element.getBoundingClientRect(); fitter.measure(bounds.width, bounds.height); };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect(); fitter.stop(); abort.abort();
      // Any already sent resize can still complete. Require a new frame before input.
      setResizing(false);
    };
  }, [ended, fit, owns, connected, selectedTarget, session?.generation, session?.can_resize_viewport, session?.can_resize_agent_viewport, session?.control_state, passiveEpoch, base, resetInput, failPrivate]);
  const send = useCallback(
    (action: Record<string, unknown>) => {
      if (!owns || working || resizeBlocked.current || !connected || !media.current?.frame) {
        return;
      }
      if (!enqueueInput(queue.current, { action, frame: media.current.frame })) {
        setError("Input is catching up. Please wait.");
        return;
      }
      if (sending.current) return;
      const epoch = inputEpoch.current;
      sending.current = true;
      void (async () => {
        let dispatched = false;
        try {
          while (queue.current.length && epoch === inputEpoch.current) {
            dispatched = false;
            const { action: next, frame: original } = queue.current.shift()!;
            const frame = media.current?.frame;
            if (
              !frame ||
              !inputMatchesFrame({ action: next, frame: original }, frame)
            )
              throw new Error("page changed");
            if (next.kind === "text" || next.kind === "key") {
              if (!focus.current) throw new Error("select a field");
              next.focus_token = focus.current;
            }
            dispatched = true;
            const result = await apiFetchJson<{ focus_token: string | null }>(
              `${base}/input`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  viewer_id: viewerId.current,
                  target_id: frame.target_id,
                  document_id: frame.document_id,
                  frame_token: frame.frame_token,
                  input: next,
                }),
              },
            );
            if (epoch === inputEpoch.current) {
              focus.current = result.focus_token;
              if (next.kind === "back") resetInput();
            }
          }
        } catch (failure) {
          resetInput();
          const code = isApiError(failure) ? failure.message : "";
          if (dispatched && (!code || ["browser_input_uncertain", "browser_interrupted", "browser_control_expired", "browser_private_or_paused"].includes(code)))
            failPrivate("Browser input was not confirmed. Private control is paused; the input has not been retried.", 2);
          else if (mounted.current && !failurePriority.current)
            setError(code === "browser_no_previous_page" ? "No previous page in this tab." : "Input was rejected. Select the field again; text has not been retried.");
        } finally {
          sending.current = false;
        }
      })();
    },
    [owns, working, connected, base, resetInput, failPrivate],
  );
  const point = (event: { clientX: number; clientY: number }) => {
    const bounds = canvas.current!.getBoundingClientRect();
    const frame = media.current?.frame;
    return frame
      ? {
          x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
          y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
        }
      : null;
  };
  useEffect(() => {
    const element = canvas.current;
    if (!element || !owns || working || !connected) return;
    const wheel = (event: WheelEvent) => {
      const frame = media.current?.frame;
      if (!frame) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
      send({
        kind: "scroll",
        x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
        y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
        delta_y: Math.max(-2000, Math.min(2000, event.deltaY * scale)),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [send, owns, working, connected]);
  if (ended) {
    const restarted = !missing && session?.runtime_status === "daemon_restarted";
    const recoverable = !missing && session?.can_take_control;
    const primaryOperation = canReturn ? "return" : recoverable ? (restarted ? "reopen" : "acquire") : null;
    return (
      <main className={`flex min-h-0 flex-col items-start justify-center gap-3 overflow-y-auto bg-background p-6 text-foreground ${embedded ? "h-full" : "h-dvh"}`}>
        <h1 className="font-semibold">{missing ? "Browser session unavailable" : restarted ? "Recover browser pages" : recoverable ? "Browser needs recovery" : "Browser session ended"}</h1>
        <p className="text-sm text-muted-foreground">{canReturn
          ? "Return control so Bud can continue browsing."
          : restarted ? "Bud restarted. You can reopen saved pages or ask Bud to open a page. Your saved sign-ins remain."
          : recoverable ? "Take control to recover this workspace, or ask Bud to open a page."
          : "Ask Bud to open a page in the conversation."}</p>
        <div className="flex flex-wrap gap-2">
          {primaryOperation && <button className={button} disabled={working} onClick={() => void control(primaryOperation)}>
            {working ? primaryOperation === "return" ? "Returning…" : "Recovering…"
              : primaryOperation === "return" ? "Return to agent" : primaryOperation === "reopen" ? "Reopen saved pages" : "Take control"}
          </button>}
          {embedded ? <button className={button} onClick={onDismiss}>Dismiss browser pane</button>
            : <a className={button} href={session ? `/${session.bud_id}/${session.thread_id}` : "/"}>Conversation</a>}
        </div>
        {(error || statusError) && <p role="alert" className="text-sm text-destructive">{error || statusError}</p>}
        {!missing && session && <>
          <button type="button" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            aria-expanded={recoveryOptionsOpen} aria-controls={`browser-recovery-options-${sessionId}`}
            onClick={() => setRecoveryOptionsOpen(value => !value)}>More options</button>
          {recoveryOptionsOpen && <section id={`browser-recovery-options-${sessionId}`} aria-label="Browser recovery options" className="w-full space-y-3">
            {restarted && recoverable && <p className="text-sm text-muted-foreground">Reopening saved pages takes private control. Back history and unsaved edits are not restored. Pages load again; form submissions are not replayed. URLs with query strings, fragments or authentication callbacks are excluded.</p>}
            <div className="flex flex-wrap gap-2">
              {restarted && recoverable && primaryOperation !== "reopen" && <button className={button} disabled={working} onClick={() => void control("reopen")}>Reopen saved pages</button>}
              {recoverable && primaryOperation !== "acquire" && <button className={button} disabled={working} onClick={() => void control("acquire")}>{restarted ? "Start blank workspace" : "Take control"}</button>}
              {session.state !== "closing" && <button className={button} disabled={working} onClick={() => void control("close")}>Close this thread’s tabs</button>}
            </div>
            <BrowserLifecycle budId={session.bud_id} />
          </section>}
        </>}
      </main>
    );
  }
  return (
    <main className={`group/browser-pane relative min-h-0 min-w-0 w-full overflow-hidden bg-background text-foreground ${embedded ? "h-full" : "h-dvh"}`}>
      <div ref={surface} className="absolute inset-0 overflow-hidden bg-secondary">
        {empty && <div role="status" className="absolute inset-0 flex items-center justify-center p-6 text-sm text-muted-foreground">
          {owns ? "No page is open. Return to agent to open a page." : "No page is open. Ask Bud to open a page."}
        </div>}
        {!connected && !empty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-sm">
          <p>
            {recovering ? "Reconnecting your private browser view…" : owns
              ? "Connecting to browser…"
              : session?.can_view ? "Reconnecting to browser…" : "Browser control is paused. Take control to reconnect."}
          </p>
          {!owns && !recovering && session?.runtime_status !== "disconnected" && session && !session.can_view && (
            <button type="button" className={button} disabled={working || takeoverPending}
              onClick={() => void control("acquire")}>Take control</button>
          )}
          </div>
        )}
        <canvas
          ref={canvas}
          className="absolute inset-0 m-auto block max-h-full max-w-full object-contain"
          aria-label="Remote browser page"
          onClick={(event) => {
            const p = point(event);
            if (p && owns && connected && !working && !resizeBlocked.current) {
              send({ kind: "click", ...p });
              setMenuOpen(false);
              typing.current?.focus({ preventScroll: true });
            }
          }}
        />
      </div>
      {!owns && connected && session?.can_view && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/15 opacity-0 transition-opacity duration-150 [@media(hover:hover)]:group-hover/browser-pane:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
          <button
            type="button"
            className={`${button} pointer-events-none bg-background/95 px-5 py-3 font-medium shadow-lg backdrop-blur [@media(hover:hover)]:group-hover/browser-pane:pointer-events-auto focus:pointer-events-auto focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring`}
            disabled={working || resizing || takeoverPending}
            onClick={() => { setMenuOpen(false); void control("acquire"); }}
          >
            {working || takeoverPending ? "Taking control…" : "Take control"}
          </button>
        </div>
      )}
        <textarea
          ref={typing}
          rows={1}
          aria-label="Remote browser keyboard input"
          tabIndex={-1}
          autoComplete="off"
          spellCheck={false}
          disabled={!owns || !connected || working || resizing}
          className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none overflow-hidden opacity-0"
          onChange={(event) => {
            if (
              !(event.nativeEvent as InputEvent).isComposing &&
              event.target.value
            ) {
              send({ kind: "text", text: event.target.value });
              event.target.value = "";
            }
          }}
          onCompositionEnd={(event) => {
            if (event.currentTarget.value) {
              send({ kind: "text", text: event.currentTarget.value });
              event.currentTarget.value = "";
            }
          }}
          onKeyDown={(event) => {
            if (
              [
                "Tab",
                "Enter",
                "Backspace",
                "Delete",
                "ArrowLeft",
                "ArrowRight",
                "Home",
                "End",
              ].includes(event.key) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send({ kind: "key", key: event.key });
            }
          }}
        />
      {owns && session?.can_navigate_history && (
        <div className="group absolute bottom-0 left-0 z-10 p-3">
          <button type="button" aria-label="Go back" title="Go back"
            className={`${button} bg-background/95 shadow-md backdrop-blur transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
            disabled={!connected || working || resizing}
            onClick={() => {
              if (sending.current) return;
              resetInput();
              setMenuOpen(false);
              send({ kind: "back" });
            }}>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-end"
        onMouseEnter={() => setMenuOpen(true)}
        onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setMenuOpen(false); }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            menuButton.current?.focus();
            setMenuOpen(false);
          }
        }}>
        <button ref={menuButton} type="button" aria-label="Browser controls" aria-expanded={menuOpen}
          aria-controls={`browser-controls-${sessionId}`}
          className={`${button} pointer-events-auto ml-auto flex shrink-0 items-center gap-2 bg-background/95 shadow-md backdrop-blur`}
          onClick={() => setMenuOpen(value => !value)}>
          <SlidersHorizontal size={18} aria-hidden="true" />
          {error && <span className="text-destructive">Attention</span>}
        </button>
        <div hidden={!menuOpen} className="pointer-events-auto min-h-0 w-96 max-w-full overflow-y-auto pt-2">
        <section id={`browser-controls-${sessionId}`} aria-label="Browser controls panel" hidden={!menuOpen}
          className="rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur">

      <header className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <h1 className="font-semibold">Bud browser</h1>
        <span className="text-sm text-muted-foreground">
          {working
            ? "Updating control…"
            : takeoverPending
              ? "Waiting for agent to pause…"
              : owns
                ? "Private control"
                : session?.control_state === "agent"
                  ? "View only"
                  : "Paused"}
        </span>
        <div className="ml-auto flex gap-2">
          {owns ? (
            <>
              <button
                className={button}
                disabled={working || resizing}
                onClick={() => void control("release")}
              >
                Pause
              </button>
              <button
                className={button}
                disabled={working || resizing}
                onClick={() => void control("return")}
              >
                Return to agent
              </button>
            </>
          ) : (
            <button
              className={button}
              disabled={!session || working || resizing || session.state === "closing"}
              onClick={() => void control("acquire")}
            >
              Take control
            </button>
          )}
          {!embedded && <a
            className={button}
            href={session ? `/${session.bud_id}/${session.thread_id}` : "/"}
          >
            Conversation
          </a>}
          {embedded && <>
            <a className={button} href={`/browser/${encodeURIComponent(sessionId)}`} target="_blank" rel="noopener noreferrer" title="Open browser viewer in new tab">↗</a>
            <button className={button} onClick={onDismiss} aria-label="Dismiss browser pane">✕</button>
          </>}
        </div>
      </header>
      {session?.handoff?.reason && (
        <p className="mb-2 text-sm">{session.handoff.reason}</p>
      )}
      <p className="mb-3 text-sm text-muted-foreground">
        {owns
          ? "Browser work in every thread on this Bud is paused. Only this viewer receives private content. Return to agent resumes browser work across threads."
          : "Take control to interact and pause browser work across this Bud. Closing the viewer leaves private work paused."}
      </p>
      {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
      {!owns && canReturn && <button className={`${button} mb-3`} disabled={working} onClick={() => void control("return")}>{returning ? "Returning…" : "Return to agent"}</button>}
      {(error || statusError) && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error || statusError}
        </p>
      )}
      {session?.can_show_window && <div className="mb-3 flex flex-wrap gap-2">
        <button className={button} disabled={working || resizing} onClick={() => void control("show_window")}>Show browser window</button>
        {owns && <button className={button} disabled={working || resizing} onClick={() => void control("hide_window")}>Hide browser window</button>}
        <p className="text-xs text-muted-foreground">Opens on the Bud’s machine and takes private control. Hide keeps browser work paused.</p>
      </div>}
      <div className="mb-2 flex items-center gap-2">
        <label className="text-sm">
          Page{" "}
          <select
            className="rounded border p-1"
            disabled={!owns || !connected || resizing}
            value={selectedTarget}
            onChange={(event) => {
              resetInput();
              setSelectedTarget(event.target.value);
              media.current?.selectTarget(event.target.value);
            }}
          >
            {!targets.length && <option value="">No page available</option>}
            {targets.map((target) => (
              <option key={target.target_id} value={target.target_id}>
                {target.origin || "Blank page"}
              </option>
            ))}
          </select>
        </label>
        {!connected && !empty && (
          <button
            className={button}
            onClick={() => { resizeBlocked.current = false; setMediaVersion((v) => v + 1); }}
          >
            Reconnect view
          </button>
        )}
      </div>
      <div className="mb-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <label><input type="checkbox" checked={fit} disabled={resizing || !session?.can_resize_viewport} onChange={event => setFit(event.target.checked)} /> Fit pane</label>
        <span>{resizing ? "Fitting page…" : !session?.can_resize_viewport ? "Update Bud to enable fitting" : !owns && !session?.can_resize_agent_viewport ? "Update Bud to fit while the agent browses" : !fit ? "Keeping page size" : ""}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Basic page input is supported. File uploads, passkeys and
        operating-system password dialogs are not supported yet.
      </p>
      <button
        className={`${button} mt-4 self-start text-destructive`}
        disabled={!session || working || resizing || session.state === "closing"}
        onClick={() => void control("close")}
      >
        Close this thread’s tabs
      </button>
      {session && <BrowserLifecycle budId={session.bud_id} />}
        </section>
        </div>
      </div>
    </main>
  );
}
