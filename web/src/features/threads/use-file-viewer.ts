import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiFetch,
  apiFetchJson,
  readResponseErrorMessage,
} from '@/lib/transport'
import type { ApiOpenThreadFileResponse } from '@/lib/api-types'
import type { OpenFileCandidate } from '@/lib/file-paths'
import {
  openFileViewerCandidateFlow,
  type FileViewerFlowStateAccess,
  type FileViewerFlowTransport,
} from './file-viewer-flow'
import {
  EMPTY_FILE_VIEWER_STATE,
  type FileViewerState,
} from './file-viewer-state'

export type {
  FileViewerEntry,
  FileViewerKind,
  FileViewerStatus,
} from './file-viewer-state'

type UseFileViewerArgs = {
  threadId: string | null
  onError: (message: string) => void
  shouldAbortForUnauthorized: (response?: Response | null) => boolean
}

export function useFileViewer({
  threadId,
  onError,
  shouldAbortForUnauthorized,
}: UseFileViewerArgs) {
  const [state, setState] = useState<FileViewerState>(EMPTY_FILE_VIEWER_STATE)
  const stateRef = useRef<FileViewerState>(EMPTY_FILE_VIEWER_STATE)

  const setFlowState = useCallback((updater: (current: FileViewerState) => FileViewerState) => {
    setState((current) => {
      const next = updater(current)
      stateRef.current = next
      return next
    })
  }, [])

  const updateEntry = useCallback<FileViewerFlowStateAccess['updateEntry']>((key, updater) => {
    setFlowState((current) => {
      const nextEntry = updater(current.entries_by_key[key] ?? null)
      return {
        active_key: key,
        entries_by_key: {
          ...current.entries_by_key,
          [key]: nextEntry,
        },
      }
    })
  }, [setFlowState])

  const stateAccess = useMemo<FileViewerFlowStateAccess>(() => ({
    getState: () => stateRef.current,
    setState: setFlowState,
    updateEntry,
  }), [setFlowState, updateEntry])

  const transport = useMemo<FileViewerFlowTransport>(() => ({
    openThreadFile: (targetThreadId, body) =>
      apiFetchJson<ApiOpenThreadFileResponse>(`/api/threads/${targetThreadId}/files/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirectOnUnauthorized: false,
      }),
    fetchFile: (url, init) => apiFetch(url, init),
    shouldAbortForUnauthorized,
    readResponseErrorMessage,
  }), [shouldAbortForUnauthorized])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    stateRef.current = EMPTY_FILE_VIEWER_STATE
    setState(EMPTY_FILE_VIEWER_STATE)
  }, [threadId])

  const openFileCandidate = useCallback(async (
    candidate: OpenFileCandidate,
    options: { forceNewSession?: boolean } = {},
  ) => {
    await openFileViewerCandidateFlow({
      threadId,
      candidate,
      forceNewSession: options.forceNewSession,
      stateAccess,
      transport,
      onError,
    })
  }, [onError, stateAccess, threadId, transport])

  const reloadActiveFile = useCallback(() => {
    const activeKey = stateRef.current.active_key
    const activeEntry = activeKey ? stateRef.current.entries_by_key[activeKey] : null
    if (!activeEntry) {
      return
    }
    void openFileCandidate(
      activeEntry.path_kind === 'absolute_posix'
        ? {
            path_kind: 'absolute_posix',
            raw_path: activeEntry.raw_path,
            requested_path: activeEntry.requested_path ?? activeEntry.raw_path,
            display_path: activeEntry.display_path,
            ...(activeEntry.line ? { line: activeEntry.line } : {}),
            ...(activeEntry.column ? { column: activeEntry.column } : {}),
            source: activeEntry.source ?? { kind: 'unknown' },
          }
        : {
            path_kind: 'relative',
            raw_path: activeEntry.raw_path,
            relative_path: activeEntry.relative_path ?? activeEntry.display_path,
            ...(activeEntry.line ? { line: activeEntry.line } : {}),
            ...(activeEntry.column ? { column: activeEntry.column } : {}),
            source: activeEntry.source ?? { kind: 'unknown' },
          },
      { forceNewSession: true },
    )
  }, [openFileCandidate])

  const closeFileViewer = useCallback(() => {
    setFlowState((current) => ({
      ...current,
      active_key: null,
    }))
  }, [setFlowState])

  const activeEntry = state.active_key ? state.entries_by_key[state.active_key] ?? null : null

  return {
    activeEntry,
    openFileCandidate,
    reloadActiveFile,
    closeFileViewer,
  }
}
