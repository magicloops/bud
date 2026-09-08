import { useId, useRef, type ReactNode } from 'react'

/** Native modal supplies focus trapping, Escape, and inert background behavior. */
export function ReviewDetails({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  return <>
    <button type="button" className="rounded border px-3 py-2" onClick={() => ref.current?.showModal()}>View details</button>
    <dialog ref={ref} aria-labelledby={id} className="settings-surface m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl border-2 border-border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/40">
      <header className="mb-4 flex items-center justify-between gap-4"><h2 id={id} className="text-lg font-semibold">{title}</h2><button type="button" onClick={() => ref.current?.close()}>Close</button></header>
      <div className="space-y-3 text-sm">{children}</div>
    </dialog>
  </>
}
