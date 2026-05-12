import { parseFilePathCandidate, type FilePathCandidate } from '../../../lib/file-paths.ts'
import type { MessageFileActionContext } from '../types'

export type AllowedFilePathKind = FilePathCandidate['path_kind']

type FileCandidateOptions = {
  allowedPathKinds?: readonly AllowedFilePathKind[]
}

export type MarkdownLinkAction =
  | { kind: 'file'; candidate: FilePathCandidate }
  | { kind: 'external'; href: string }
  | { kind: 'unsupported_local' }
  | { kind: 'unsafe' }

export function getMarkdownLinkFileCandidate(
  href: string | undefined,
  fileActions: MessageFileActionContext | undefined,
  options: FileCandidateOptions = {},
): FilePathCandidate | null {
  if (!fileActions || !href) {
    return null
  }
  const candidate = parseFilePathCandidate(href, 'markdown_link')
  return isAllowedCandidate(candidate, options) ? candidate : null
}

export function getMarkdownLinkAction(
  href: string | undefined,
  fileActions: MessageFileActionContext | undefined,
  options: { inertLocalLinks?: boolean } & FileCandidateOptions = {},
): MarkdownLinkAction {
  const fileCandidate = getMarkdownLinkFileCandidate(href, fileActions, options)
  if (fileCandidate) {
    return { kind: 'file', candidate: fileCandidate }
  }
  if (!href) {
    return { kind: 'unsafe' }
  }
  if (hasUnsafeProtocol(href)) {
    return { kind: 'unsafe' }
  }
  if (isExternalHref(href)) {
    return { kind: 'external', href }
  }
  if (options.inertLocalLinks && isLocalHref(href)) {
    return { kind: 'unsupported_local' }
  }
  return { kind: 'external', href }
}

export function getInlineCodeFileCandidate(
  text: string,
  fileActions: MessageFileActionContext | undefined,
  options: FileCandidateOptions = {},
): FilePathCandidate | null {
  if (!fileActions) {
    return null
  }
  const candidate = parseFilePathCandidate(text, 'inline_code')
  return isAllowedCandidate(candidate, options) ? candidate : null
}

export function createFileOpenClickHandler(
  fileActions: MessageFileActionContext,
  candidate: FilePathCandidate,
): () => void {
  return () => fileActions.onOpenFileCandidate(candidate)
}

function isExternalHref(href: string): boolean {
  return /^(https?|mailto):/i.test(href)
}

function hasUnsafeProtocol(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !isExternalHref(href)
}

function isAllowedCandidate(
  candidate: FilePathCandidate | null,
  options: FileCandidateOptions,
): candidate is FilePathCandidate {
  if (!candidate) {
    return false
  }
  return !options.allowedPathKinds || options.allowedPathKinds.includes(candidate.path_kind)
}

function isLocalHref(href: string): boolean {
  if (href.startsWith('#')) {
    return true
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    return false
  }
  return true
}
