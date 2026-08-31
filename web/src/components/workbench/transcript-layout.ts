/**
 * Shared content-column classes for full-bleed transcript rows: rows span
 * the full pane width (so hover highlights run edge to edge) and constrain
 * their CONTENT to a centered column. Gutter tiers are keyed to the pane's
 * own width via the scroll container's @container; keep the values in sync
 * with useComposerContentInset (chat-pane-resize).
 */
export const TRANSCRIPT_COLUMN_CLASSES =
  'mx-auto w-full max-w-[820px] px-2 @md:px-[15px] @3xl:px-[30px]'
