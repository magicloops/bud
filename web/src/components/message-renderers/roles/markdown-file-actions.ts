import { parseFilePathCandidate, type FilePathCandidate } from '../../../lib/file-paths.ts'
import type { MessageFileActionContext } from '../types'

export function getMarkdownLinkFileCandidate(
  href: string | undefined,
  fileActions: MessageFileActionContext | undefined,
): FilePathCandidate | null {
  if (!fileActions || !href) {
    return null
  }
  return parseFilePathCandidate(href, 'markdown_link')
}

export function getInlineCodeFileCandidate(
  text: string,
  fileActions: MessageFileActionContext | undefined,
): FilePathCandidate | null {
  if (!fileActions) {
    return null
  }
  return parseFilePathCandidate(text, 'inline_code')
}

export function createFileOpenClickHandler(
  fileActions: MessageFileActionContext,
  candidate: FilePathCandidate,
): () => void {
  return () => fileActions.onOpenFileCandidate(candidate)
}
