import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Search, Trash2, X } from 'lucide-react'
import { apiFetch, apiFetchJson } from '@/lib/transport'
import type { Attachment, FileDraft } from './attachments'

type Page = { files: Attachment[]; next_cursor: string | null }
export function FileLibrary({ draft, onClose }: { draft: FileDraft; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<Page>({ files: [], next_cursor: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => { dialog.current?.showModal(); return () => request.current?.abort() }, [])
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    setLoading(true); setError(null); setPage({ files: [], next_cursor: null })
    const timer = setTimeout(() => {
      void apiFetchJson<Page>(`/api/uploads?query=${encodeURIComponent(query)}&limit=20`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setPage(result) })
        .catch(() => { if (!controller.signal.aborted) setError('Could not load your files. Try again.') })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, revision])
  const more = async () => {
    if (!page.next_cursor || loading) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    setLoading(true); setError(null)
    try {
      const next = await apiFetchJson<Page>(`/api/uploads?query=${encodeURIComponent(query)}&cursor=${page.next_cursor}&limit=20`, { signal: controller.signal })
      if (!controller.signal.aborted) setPage(old => ({ files: [...old.files, ...next.files], next_cursor: next.next_cursor }))
    } catch { if (!controller.signal.aborted) setError('Could not load more files. Try again.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const remove = async (file: Attachment) => {
    setDeleting(file.file_id); setError(null)
    try {
      const response = await apiFetch(`/api/uploads/${file.file_id}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) throw Error('delete failed')
      draft.forget(file.file_id); setConfirm(null); refresh(value => value + 1)
    } catch { setError('Could not delete this file. Try again.') }
    finally { setDeleting(null) }
  }
  return createPortal(<dialog ref={dialog} aria-labelledby="file-library-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    className="m-auto w-[min(36rem,calc(100%-2rem))] max-h-[85vh] rounded-xl border-2 border-black bg-background p-0 text-foreground shadow-xl backdrop:bg-black/60">
    <section className="flex max-h-[85vh] flex-col p-5" onClick={event => event.stopPropagation()}>
      <header className="flex items-center justify-between gap-3">
        <h2 id="file-library-title" className="text-lg font-semibold">Your files</h2>
        <button type="button" aria-label="Close file library" onClick={onClose} className="p-2"><X size={20} /></button>
      </header>
      <p className="mb-4 text-sm text-muted-foreground">Saved across chats. Bud can find and use these files when relevant to your requests.</p>
      <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
        <Search size={17} /><input autoFocus aria-label="Search your files" placeholder="Search files…" value={query}
          onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <input ref={input} type="file" multiple hidden onChange={event => { draft.add(Array.from(event.target.files ?? [])); onClose() }} />
      <button type="button" onClick={() => input.current?.click()} disabled={draft.items.length >= 10}
        className="my-3 self-start rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50">Upload files</button>
      <div className="min-h-24 overflow-y-auto">
        {!loading && !page.files.length && !error && <p className="py-6 text-center text-sm text-muted-foreground">{query ? 'No matching files.' : 'Upload a file to start your library.'}</p>}
        <ul className="divide-y divide-border">{page.files.map(file => {
          const selected = draft.ready.some(value => value.file_id === file.file_id)
          return <li key={file.file_id} className="py-3">
            <div className="flex items-center gap-3">
              <FileText size={20} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm" title={file.name}>{file.name}</p>
                <p className="text-xs text-muted-foreground">{Math.max(1, Math.round(file.size_bytes / 1024))} KB</p></div>
              <button type="button" disabled={selected || draft.items.length >= 10 || Boolean(deleting)}
                onClick={() => { const failure = draft.select(file); if (failure) setError(failure) }}
                className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">{selected ? 'Attached' : 'Attach'}</button>
              <button type="button" aria-label={`Delete ${file.name}`} disabled={Boolean(deleting)} onClick={() => setConfirm(file.file_id)} className="p-2 text-muted-foreground hover:text-destructive"><Trash2 size={16} /></button>
            </div>
            {confirm === file.file_id && <div className="mt-3 rounded-lg border border-border p-3 text-sm">
              <p>Delete {file.name} from your library? It will become unavailable in all chats. Existing conversation text stays.</p>
              <div className="mt-2 flex gap-3"><button type="button" disabled={Boolean(deleting)} onClick={() => void remove(file)} className="text-destructive underline">{deleting ? 'Deleting…' : 'Delete file'}</button>
                <button type="button" disabled={Boolean(deleting)} onClick={() => setConfirm(null)}>Keep file</button></div>
            </div>}
          </li>
        })}</ul>
        {loading && <p role="status" className="py-3 text-sm text-muted-foreground">Loading files…</p>}
        {error && <div role="alert" className="py-3 text-sm text-destructive">{error} <button type="button" className="underline" onClick={() => refresh(value => value + 1)}>Reload</button></div>}
        {page.next_cursor && <button type="button" disabled={loading} onClick={() => void more()} className="py-3 text-sm underline">Load more</button>}
      </div>
      <button type="button" onClick={onClose} className="mt-4 self-end rounded-lg border-2 border-black bg-[var(--bud-accent-muted)] px-4 py-2 text-sm text-black">Done</button>
    </section>
  </dialog>, document.body)
}
