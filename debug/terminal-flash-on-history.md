# Debug: terminal-flash-on-history

## Environment
- macOS dev host running `pnpm dev` (service + web).
- Bud agent connected locally (`cargo run -- --server ws://localhost:3000/ws ...`).
- Browser: Vite dev server (React 19, Fast Refresh).

## Repro steps
1. Open the web UI, select a thread, trigger a new run (e.g., ask Bud to `ls` then `cat`).
2. Watch the terminal pane while the run streams via SSE.
3. When the run finishes, the pane briefly flashes / jumps as history reloads—even though we dedupe entries by `run_id`.

## Observed
- During a run, `terminalEntries` contains the live SSE entry.
- On `final`, we call `setTerminalEntries([])` and `loadRunHistory(thread, { mode: 'refresh' })`.
- Once the `/runs` request resolves, `runHistory` is replaced with a new array; `RunView` re-renders, the scroll ref jumps to bottom, and the list flickers even though the actual entries didn’t change.
- The flash occurs because:
  1. `setRunHistory` builds a new `Map -> Array` each time, so even unchanged runs get new object references, causing `RunView`’s memoized props to change.
  2. We clear `terminalEntries` immediately, so there’s a moment where only history entries render; when history arrives, the list is replaced with the sorted array, triggering another full render.

## Expected
- When a run completes, the live entry should seamlessly become the history entry without a noticeable flash or scroll jump.
- Only the entry for the completed run should update; other history rows shouldn’t re-render.

## Hypotheses
- React re-renders the entire list because we rebuild `runHistory` and `terminalEntries`, causing key reorderings (`historyEntries` array is re-sorted).
- Clearing `terminalEntries` before history arrives means we show “nothing” briefly, so when history data comes back the whole list gets re-created.
- Scroll-to-bottom effect (`useEffect` in `RunView`) runs on every `combinedEntries.length` change, so even if rows didn’t change, it forces a scroll jump.

## Proposed fix
- Keep history entries in a stable map or `useRef` keyed by `runId`, and derive the array with `useMemo` only when map contents truly change (e.g., compare JSON or timestamps).
- Defer `setTerminalEntries([])` until after history merges (or keep the SSE entry until the history promise resolves) so the combined list never goes empty.
- Add equality checks before calling `setRunHistory` to avoid re-rendering when data is identical.
- Suppress scroll-to-bottom when only history refreshed without new live entries (so we don’t scroll even if refs change).

## Next actions
- [x] Document and analyze the flash cause.
- [ ] Adjust history merge logic to minimize re-renders (use stable map + equality guard).
- [ ] Delay clearing `terminalEntries` until history refresh completes (or merge live entry into history map before clearing).
