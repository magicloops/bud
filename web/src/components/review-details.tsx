import { useEffect, useId, useRef, type ReactNode } from 'react'

/** Native modal supplies focus trapping, Escape, and inert background behavior. */
export function ReviewDetails({ title, label = 'View details', triggerClassName = 'review-details-link', closed = false, children }: {
  title: string
  /** The opening button. A card whose action lives in the dialog passes its own, unstyled as a link. */
  label?: string
  triggerClassName?: string
  /** Closes the dialog when it turns true, e.g. once the decision made inside it is saved. */
  closed?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => { if (closed) ref.current?.close() }, [closed])
  return <>
    <button type="button" className={triggerClassName} onClick={() => ref.current?.showModal()}>{label}</button>
    <dialog ref={ref} aria-labelledby={id} className="settings-surface m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl border-2 border-border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/40">
      <header className="mb-4 flex items-center justify-between gap-4"><h2 id={id} className="text-lg font-semibold">{title}</h2><button type="button" onClick={() => ref.current?.close()}>Close</button></header>
      <div className="space-y-3 text-sm">{children}</div>
    </dialog>
  </>
}
