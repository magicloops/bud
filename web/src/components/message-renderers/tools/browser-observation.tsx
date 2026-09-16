import { useState } from 'react'
import type { ToolContentRendererProps } from '../types'

export function BrowserObservationContent({ payload }: ToolContentRendererProps) {
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  const data = payload.data as Record<string, unknown> | undefined
  const observation = data?.observation as Record<string, unknown> | undefined
  const artifact = data?.image_artifact as Record<string, unknown> | undefined
  const path = typeof artifact?.path === 'string' && /^\/api\/threads\/[a-f0-9-]{36}\/browser-images\/\d+-[0-9A-HJKMNP-TV-Z]{26}$/.test(artifact.path) ? artifact.path : null
  const text = typeof observation?.text === 'string' ? observation.text : null
  return <div className="space-y-2 text-sm">
    <p>{typeof payload.summary === 'string' ? payload.summary : 'Browser observation'}</p>
    {observation?.truncated === true && <p className="text-muted-foreground">Partial snapshot · more available to the agent</p>}
    {(path || text) && <button className="text-primary underline" onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide observation' : 'Show observation'}</button>}
    {expanded && text && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{text}</pre>}
    {expanded && path && (failed ? <p>Screenshot unavailable or expired.</p> : <img src={path} alt="Browser screenshot requested by the agent" className="max-h-96 max-w-full object-contain" onError={() => setFailed(true)} />)}
  </div>
}
