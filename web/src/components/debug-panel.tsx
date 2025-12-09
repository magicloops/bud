import { useState } from 'react'
import { useParams } from '@tanstack/react-router'

type DebugPanelProps = {
  sessionId: string | null
  terminalState: string
  terminalConnection: string
}

export function DebugPanel({
  sessionId,
  terminalState,
  terminalConnection,
}: DebugPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const params = useParams({ strict: false }) as { budId?: string; threadId?: string }

  // Only render in dev mode
  if (!import.meta.env.DEV) return null

  const debugData = {
    budId: params.budId ?? null,
    threadId: params.threadId ?? null,
    sessionId,
    terminalState,
    terminalConnection,
    timestamp: new Date().toISOString(),
  }

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="bg-black text-white text-xs px-2 py-1 rounded font-mono hover:bg-gray-800 transition-colors"
      >
        {expanded ? '▼ Debug' : '▶ Debug'}
      </button>

      {expanded && (
        <div className="mt-2 bg-black/95 text-green-400 text-xs p-3 rounded font-mono max-w-sm border border-green-800">
          <div className="space-y-1">
            <div>
              <span className="text-gray-500">budId:</span>{' '}
              <span className="text-green-300">{params.budId ?? 'null'}</span>
            </div>
            <div>
              <span className="text-gray-500">threadId:</span>{' '}
              <span className="text-green-300">{params.threadId ?? 'null'}</span>
            </div>
            <div>
              <span className="text-gray-500">sessionId:</span>{' '}
              <span className="text-green-300">{sessionId ?? 'null'}</span>
            </div>
            <div>
              <span className="text-gray-500">terminalState:</span>{' '}
              <span className="text-yellow-300">{terminalState}</span>
            </div>
            <div>
              <span className="text-gray-500">terminalConn:</span>{' '}
              <span className={
                terminalConnection === 'connected' ? 'text-green-400' :
                terminalConnection === 'reconnecting' ? 'text-yellow-400' :
                'text-red-400'
              }>
                {terminalConnection}
              </span>
            </div>
          </div>

          <div className="mt-3 pt-2 border-t border-gray-700 flex gap-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(debugData, null, 2))
              }}
              className="text-blue-400 hover:text-blue-300 hover:underline"
            >
              Copy JSON
            </button>
            <button
              onClick={() => console.log('[Debug]', debugData)}
              className="text-blue-400 hover:text-blue-300 hover:underline"
            >
              Log
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
