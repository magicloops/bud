/**
 * New Thread View - workspace for composing a new thread
 *
 * RELATED FILE: See $threadId.tsx for the existing thread workspace.
 * These two routes share similar layout structure and components.
 * When modifying layout or shared behavior, check BOTH files.
 *
 * DO NOT REMOVE THIS COMMENT - it prevents accidental divergence.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useRef, useEffect, type FormEvent } from 'react'
import { WorkspaceShell } from '@/components/workbench/workspace-shell'
import { CommandComposer } from '@/components/workbench/command-composer'
import { DebugPanel } from '@/components/debug-panel'
import { useLayout } from '@/contexts/layout-context'
import {
  normalizeReasoningForModel,
  useAvailableModels,
  type ReasoningLevel,
} from '@/lib/models'
import { generateMessageClientId } from '@/lib/messages'
import { apiFetch } from '@/lib/transport'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

export const Route = createFileRoute('/$budId/new')({
  component: NewThreadView,
})

function NewThreadView() {
  const { budId } = Route.useParams()
  const navigate = useNavigate()

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { toggleThreadPanel } = useLayout()

  const [messageText, setMessageText] = useState('')
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningLevel>('none')
  const [viewMode, setViewMode] = useState<'terminal' | 'web'>('terminal')
  const { models, selectedModel, setSelectedModel } = useAvailableModels()

  // Terminal state (no connection in "new thread" mode)
  const [terminalState] = useState<string>('idle')
  const [terminalConnection] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const handleModelChange = (nextModel: string) => {
    setSelectedModel(nextModel)
    setReasoningEffort((current) => normalizeReasoningForModel(models, nextModel, current))
  }

  useEffect(() => {
    setReasoningEffort((current) => normalizeReasoningForModel(models, selectedModel, current))
  }, [models, selectedModel])

  // Initialize xterm
  useEffect(() => {
    const initTerminal = async () => {
      if (!terminalPaneRef.current || terminalRef.current) return

      const { Terminal } = await import('xterm')
      const { FitAddon } = await import('xterm-addon-fit')

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
        theme: {
          background: '#1a1a1a',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
        },
        allowProposedApi: true,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)

      term.open(terminalPaneRef.current)
      fitAddon.fit()

      terminalRef.current = term
      fitAddonRef.current = fitAddon
    }

    initTerminal()

    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Fit terminal on resize
  useEffect(() => {
    const handleResize = () => {
      fitAddonRef.current?.fit()
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!budId) {
      setError('No Bud selected')
      return
    }
    const formData = new FormData(e.currentTarget)
    const submittedMessage = String(formData.get('message') ?? '')
    const trimmedMessage = submittedMessage.trim()
    if (!trimmedMessage) {
      setError('Message cannot be empty')
      return
    }

    setError(null)
    setStatus('dispatching')
    setMessageText('')
    const clientId = generateMessageClientId()

    try {
      // Create thread
      const threadResp = await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bud_id: budId })
      })
      if (!threadResp.ok) {
        const body = await threadResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${threadResp.status}`)
      }
      const { thread_id } = (await threadResp.json()) as { thread_id: string }

      // Post message
      const messageResp = await apiFetch(`/api/threads/${thread_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmedMessage,
          client_id: clientId,
          model: selectedModel || undefined,
          reasoning_effort: selectedModel ? reasoningEffort : undefined
        })
      })
      if (!messageResp.ok) {
        const body = await messageResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${messageResp.status}`)
      }

      // Navigate to the new thread
      navigate({ to: '/$budId/$threadId', params: { budId, threadId: thread_id } })
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Failed to create thread')
    }
  }

  const terminalOverlayMessage = 'Terminal session will be created when you start a conversation.'

  return (
    <WorkspaceShell
      title="New Thread"
      view={viewMode}
      onViewChange={setViewMode}
      onToggleThreads={toggleThreadPanel}
      status={status}
      leftPane={(
        <div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="text-center text-muted-foreground">
              <p className="text-lg font-medium">Start a new conversation</p>
              <p className="mt-1 text-sm">Send a message to create a thread and terminal session</p>
            </div>
          </div>
        </div>
      )}
      rightPane={(
        <div className="relative flex flex-1 flex-col overflow-hidden border-l-4 border-black bg-black">
          {viewMode === 'web' && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
              <div className="rounded-2xl border-4 border-black bg-card px-10 py-8 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
                <p className="text-lg font-mono font-semibold text-card-foreground">Web preview placeholder</p>
                <p className="text-sm text-muted-foreground">Screencasts or browser mirroring will live here.</p>
              </div>
            </div>
          )}
          <div className={`relative flex-1 min-h-0 overflow-hidden ${viewMode === 'web' ? 'invisible' : ''}`}>
            <div ref={terminalPaneRef} className="h-full w-full overflow-hidden font-mono text-sm" />
            {viewMode === 'terminal' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
                <p className="px-4 text-center text-sm text-muted-foreground">
                  {terminalOverlayMessage}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      composer={(
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          status={status}
          onSubmit={handleSubmit}
          error={error}
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          reasoningEffort={reasoningEffort}
          onReasoningChange={setReasoningEffort}
        />
      )}
      debugPanel={(
        <DebugPanel
          sessionId={null}
          terminalState={terminalState}
          terminalConnection={terminalConnection}
        />
      )}
    />
  )
}
