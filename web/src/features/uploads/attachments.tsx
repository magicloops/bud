import { useEffect, useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import { apiFetch, apiFetchJson } from '@/lib/transport'

export type Attachment = { file_id: string; name: string; mime_type: string; size_bytes: number }
type DraftItem = { key: string; source?: File; file?: Attachment; name: string; size: number; error?: string; controller?: AbortController }
export function useFileDraft() {
  const [items, setItems] = useState<DraftItem[]>([])
  const current = useRef(items)
  const update = (next: DraftItem[]) => { current.current = next; setItems(next) }
  useEffect(() => () => current.current.forEach(item => item.controller?.abort()), [])
  const upload = async (item: DraftItem) => {
    if (!item.source) return
    const controller = new AbortController()
    update(current.current.map(value => value.key === item.key ? { ...value, error: undefined, controller } : value))
    try {
      const reserved = await apiFetchJson<Attachment>('/api/uploads', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.source.name, mime_type: item.source.type || 'application/octet-stream', size_bytes: item.source.size }) })
      const file = await apiFetchJson<Attachment>(`/api/uploads/${reserved.file_id}/content`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: item.source, signal: controller.signal,
      })
      if (!controller.signal.aborted) update(current.current.map(value => value.key === item.key ? { ...value, file, controller: undefined } : value))
    } catch (error) {
      if (!controller.signal.aborted) update(current.current.map(value => value.key === item.key ? {
        ...value, controller: undefined, error: error instanceof Error ? error.message : 'Upload failed',
      } : value))
    }
  }
  const add = (sources: File[]) => {
    const added: DraftItem[] = []
    for (const source of sources) {
      if (current.current.length + added.length >= 10) break
      const total = [...current.current, ...added].reduce((sum, item) => sum + item.size, 0) + source.size
      const error = source.size === 0 ? 'This file is empty.' : source.size > 25 * 1024 * 1024 ? 'Maximum file size is 25 MB.' :
        total > 100 * 1024 * 1024 ? 'Maximum attachment total is 100 MB.' : undefined
      added.push({ key: crypto.randomUUID(), source, name: source.name, size: source.size, error })
    }
    update([...current.current, ...added])
    // Sequential uploads keep client/server memory and parser pressure bounded.
    void (async () => { for (const item of added) if (!item.error && current.current.some(value => value.key === item.key)) await upload(item) })()
  }
  return { items, add, ready: items.flatMap(item => item.file ? [item.file] : []),
    blocked: items.some(item => !item.file),
    remove(key: string) { current.current.find(item => item.key === key)?.controller?.abort(); update(current.current.filter(item => item.key !== key)) },
    retry(key: string) { const item = current.current.find(item => item.key === key); if (item && !item.controller && item.size > 0 && item.size <= 25 * 1024 * 1024 && current.current.reduce((sum, value) => sum + value.size, 0) <= 100 * 1024 * 1024) void upload(item) },
    clear() { current.current.forEach(item => item.controller?.abort()); update([]) },
  }
}
export type FileDraft = ReturnType<typeof useFileDraft>

export function AttachmentComposer({ draft, disabled }: { draft: FileDraft; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="space-y-2 px-4 pt-3">
    <input ref={input} type="file" multiple hidden onChange={event => {
      draft.add(Array.from(event.target.files ?? [])); event.target.value = ''
    }} />
    <button type="button" disabled={disabled || draft.items.length >= 10} onClick={() => input.current?.click()}
      className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
      <Paperclip size={15} /> Attach files
    </button>
    {draft.items.length > 0 && <ul className="flex flex-wrap gap-2" aria-label="Attachments">
      {draft.items.map(item => <li key={item.key} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-xs">
        <FileText size={16} className="shrink-0" />
        <div className="min-w-0"><p className="truncate" title={item.name}>{item.name}</p>
          <p role="status" className={item.error ? 'text-destructive' : 'text-muted-foreground'}>{item.error ?? (item.file ? `${Math.max(1, Math.round(item.size / 1024))} KB` : 'Uploading…')}</p>
        </div>
        {item.error && <button type="button" disabled={disabled} className="underline" onClick={() => draft.retry(item.key)}>Retry</button>}
        <button type="button" disabled={disabled} aria-label={`Remove ${item.name}`} onClick={() => draft.remove(item.key)}><X size={14} /></button>
      </li>)}
    </ul>}
    {draft.items.length >= 10 && <p className="text-xs text-muted-foreground">Maximum 10 attachments.</p>}
  </div>
}

export function messageAttachments(metadata: unknown): Attachment[] {
  if (!metadata || typeof metadata !== 'object' || !('attachments' in metadata) || !Array.isArray(metadata.attachments)) return []
  return metadata.attachments.filter((value): value is Attachment => value &&
    /^file_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.file_id) && typeof value.name === 'string' && typeof value.size_bytes === 'number')
}

export function AttachmentCards({ metadata }: { metadata: unknown }) {
  const [error, setError] = useState<string | null>(null)
  const download = async (file: Attachment) => {
    setError(null)
    try {
      const response = await apiFetch(`/api/uploads/${file.file_id}/content`)
      if (!response.ok) throw Error(response.status === 404 ? 'This attachment is no longer available.' : 'Could not download this file. Try again.')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a'); link.href = url; link.download = file.name; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Download failed.') }
  }
  const attachments = messageAttachments(metadata)
  if (!attachments.length) return null
  return <div className="my-2 space-y-2">
    <div className="flex flex-wrap gap-2">{attachments.map(file => <button key={file.file_id} type="button"
      className="flex max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
      onClick={() => void download(file)} title={`Download ${file.name}`}><FileText size={16} className="shrink-0" /><span className="truncate">{file.name}</span></button>)}</div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
