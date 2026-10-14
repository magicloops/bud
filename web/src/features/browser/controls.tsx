import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Ellipsis, ExternalLink, X } from "lucide-react";
import { BrowserLifecycle } from "./lifecycle";
import type { BrowserStateFeed } from "./state-feed";

const row = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-secondary focus-visible:outline-ring disabled:opacity-50";
const button = "min-h-11 shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm focus-visible:outline-ring disabled:opacity-50";
const toolbarButton = "inline-flex min-h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border-2 border-black text-xs font-medium shadow-[2px_2px_0_rgba(0,0,0,1)] hover:brightness-95 focus-visible:outline-ring disabled:opacity-50";
type Panel = "options" | "pages" | "window" | "settings";

/** Presentation only. The mounted viewer retains all authority and input state. */
export function BrowserControls(props: {
  sessionId: string; budId?: string; threadId?: string; stateFeed: BrowserStateFeed;
  mobile: boolean; embedded: boolean; active: boolean; owns: boolean; busy: boolean;
  canTake: boolean; canSelect: boolean; canFit: boolean; fitSupported: boolean; canShow: boolean;
  status: string; targets: { target_id: string; origin: string }[]; selectedTarget: string;
  open: boolean; onOpenChange: (open: boolean) => void; onDismiss?: () => void;
  onTake: () => void; onReturn: () => void; onFit: () => void;
  retryView?: { disabled: boolean; run: () => void };
  onSelect: (id: string) => void; onShow: () => void; onHide: () => void; onCloseTabs: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("options");
  const [confirmClose, setConfirmClose] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  const { open, onOpenChange } = props;
  const close = () => { onOpenChange(false); trigger.current?.focus?.({ preventScroll: true }); };
  useEffect(() => {
    if (!open) { setPanel("options"); setConfirmClose(false); return; }
    const element = content.current;
    const focusable = () => Array.from(element?.querySelectorAll?.<HTMLElement>(
      'button:not(:disabled), a[href], summary, [tabindex="0"]',
    ) ?? []);
    focusable()[0]?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); onOpenChange(false); trigger.current?.focus?.({ preventScroll: true });
      } else if (event.key === "Tab") {
        const nodes = focusable(), first = nodes[0], last = nodes.at(-1);
        if (!first) return;
        if (event.shiftKey && (document.activeElement === first || !element?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus({ preventScroll: true });
        } else if (!event.shiftKey && (document.activeElement === last || !element?.contains(document.activeElement))) {
          event.preventDefault(); first.focus({ preventScroll: true });
        }
      }
    };
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, panel, onOpenChange]);
  const act = (run: () => void) => { close(); run(); };
  const status = props.status === "You have control" ? "" : props.status;
  const title = panel === "pages" ? "Switch page" : panel === "window" ? "Browser on Bud’s machine" : panel === "settings" ? "Browser settings" : "Browser options";
  return <>
    <header aria-label="Browser toolbar" className="pointer-events-none absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 flex items-start justify-end gap-2">
      <div className="pointer-events-auto flex min-w-0 items-center gap-2 bg-transparent">
        {status && <span role="status" className="hidden min-w-0 truncate px-2 text-xs text-muted-foreground @min-[26rem]/browser-pane:block">{status}</span>}
        {props.retryView && <button type="button" className={`${toolbarButton} px-2.5 py-1.5 bg-background text-foreground`}
          disabled={!props.active || props.busy || props.owns || props.retryView.disabled}
          onClick={() => act(props.retryView!.run)}>Retry view</button>}
        <button type="button" className={`${toolbarButton} px-2.5 py-1.5 bg-[var(--bud-accent-muted)] text-black`}
          disabled={!props.active || props.busy || (!props.owns && !props.canTake)}
          onClick={() => act(props.owns ? props.onReturn : props.onTake)}>
          {props.status === "Taking control…" || props.status === "Returning to agent…" ? props.status : props.owns ? "Return to agent" : "Take control"}
        </button>
        <button ref={trigger} type="button" aria-label="More browser options" aria-expanded={open}
          aria-controls={`browser-options-${props.sessionId}`} disabled={!props.active}
          className={`${toolbarButton} size-8 p-0 bg-background text-foreground`} onClick={() => onOpenChange(!open)}><Ellipsis size={18} aria-hidden="true" /></button>
        {!props.embedded && !props.mobile && <a className={`${toolbarButton} px-2.5 py-1.5 bg-background text-foreground`} href={props.budId && props.threadId ? `/${props.budId}/${props.threadId}` : "/"}>Conversation</a>}
      </div>
    </header>
    {open && <div className="absolute inset-0 z-30 bg-black/15" onPointerDown={event => { if (event.target === event.currentTarget) close(); }} />}
    <section ref={content} id={`browser-options-${props.sessionId}`} role="dialog" aria-modal={open ? true : undefined}
      aria-label={title} hidden={!open}
      className={props.mobile
        ? "absolute inset-x-2 bottom-2 z-40 max-h-[80%] overflow-y-auto rounded-2xl border border-border bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-xl"
        : "absolute right-3 bottom-20 z-40 max-h-[calc(100%-5rem)] w-80 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-border bg-background p-2 shadow-xl"}>
      <div className="flex items-center gap-2 px-1 pb-1">
        {panel !== "options" && <button type="button" className={button} aria-label="Back to browser options" onClick={() => { setPanel("options"); setConfirmClose(false); }}><ArrowLeft size={18} aria-hidden="true" /></button>}
        <h2 className="flex-1 px-2 text-sm font-medium">{title}</h2>
        <button type="button" className={button} aria-label="Close browser options" onClick={close}><X size={18} aria-hidden="true" /></button>
      </div>
      {props.mobile && status && <p className="px-3 pb-2 text-xs text-muted-foreground">{status}</p>}
      {panel === "options" && <>
        {props.owns && props.targets.length > 1 && <button type="button" className={row} disabled={props.busy || !props.canSelect} onClick={() => setPanel("pages")}>Switch page…</button>}
        {props.fitSupported && <button type="button" className={`${row} flex-col items-start gap-0.5`} disabled={!props.canFit || props.busy} onClick={() => act(props.onFit)}>
          Fit to this device<span className="text-xs text-muted-foreground">Changes the page size seen by Bud.</span>
        </button>}
        {props.embedded && !props.mobile && <a className={row} href={`/browser/${encodeURIComponent(props.sessionId)}`} target="_blank" rel="noopener noreferrer" onClick={close}><ExternalLink size={16} aria-hidden="true" />Open in new tab</a>}
        {!props.mobile && props.canShow && <button type="button" className={row} onClick={() => setPanel("window")}>Show on Bud’s machine…</button>}
        {!props.mobile && props.budId && <button type="button" className={row} onClick={() => setPanel("settings")}>Browser settings…</button>}
        {props.mobile && <details className="px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Interaction support</summary><p>Page clicks, scrolling and typing are supported. File uploads, passkeys and operating-system password dialogs are not supported yet.</p></details>}
      </>}
      {panel === "pages" && props.owns && props.targets.map(target => <button key={target.target_id} type="button" className={row}
        aria-current={target.target_id === props.selectedTarget ? "page" : undefined} disabled={props.busy || !props.canSelect}
        onClick={() => act(() => props.onSelect(target.target_id))}>{target.origin || "Blank page"}</button>)}
      {panel === "window" && !props.mobile && props.canShow && <>
        <p className="px-3 py-2 text-sm text-muted-foreground">Open Chrome on this Bud’s machine and take control. Leaving this view returns control to Bud.</p>
        <button type="button" className={row} disabled={props.busy || (!props.owns && !props.canTake)} onClick={() => act(props.onShow)}>Show browser window</button>
        {props.owns && <button type="button" className={row} disabled={props.busy} onClick={() => act(props.onHide)}>Hide browser window</button>}
        <p className="px-3 py-2 text-xs text-muted-foreground">Hide keeps your control while this view stays active. Use Return to agent when finished.</p>
      </>}
      {open && panel === "settings" && !props.mobile && props.budId && <>
        {confirmClose ? <div className="space-y-2 px-3 py-2">
          <p className="text-sm">Close this thread’s browser tabs and discard its REPL memory? Other threads and saved sign-ins stay intact.</p>
          <button type="button" className={`${button} text-destructive hover:bg-secondary`} disabled={props.busy} onClick={() => act(props.onCloseTabs)}>Close tabs</button>
          <button type="button" className={button} onClick={() => setConfirmClose(false)}>Cancel</button>
        </div> : <button type="button" className={`${row} text-destructive`} disabled={props.busy} onClick={() => setConfirmClose(true)}>Close this thread’s browser tabs…</button>}
        <BrowserLifecycle budId={props.budId} stateFeed={props.stateFeed} />
        <details className="px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Interaction support</summary><p>Page clicks, scrolling and typing are supported. File uploads, passkeys and operating-system password dialogs are not supported yet.</p></details>
      </>}
    </section>
  </>;
}
