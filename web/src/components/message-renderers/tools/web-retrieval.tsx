import type { ToolContentRendererProps } from '../types'

export function WebRetrievalContent({ payload }: ToolContentRendererProps) {
  const results = Array.isArray(payload.results) ? payload.results : []
  return <div className="space-y-2 text-sm">
    <p>{typeof payload.summary === 'string' ? payload.summary : 'Web retrieval'}</p>
    {results.map((item, index) => {
      if (!item || typeof item !== 'object') return null
      const result = item as Record<string, unknown>
      return <Source key={index} url={result.url} title={result.title} />
    })}
    {payload.operation === 'read' && <Source url={payload.url} title={payload.title} />}
    {payload.truncated === true && <p className="text-muted-foreground">Partial evidence</p>}
  </div>
}

function Source({ url, title }: { url: unknown; title: unknown }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  return <a className="block truncate underline" href={url} target="_blank" rel="noopener noreferrer">
    {typeof title === 'string' && title ? title : url}
  </a>
}
