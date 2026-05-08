# Debug: Terminal xterm bottom anchor gap

## Environment
- Web UI: React/Vite workbench terminal pane
- Terminal renderer: xterm.js with `FitAddon`
- Affected surface: existing-thread terminal right pane

## Repro Steps
1. Open a thread with the terminal pane visible.
2. Use viewport sizes where the terminal content height is not an exact multiple of the xterm row height.
3. Observe the terminal area after shortening/moving the status bar.

## Observed
- A small black gap appears between the terminal chrome and the visible xterm content at some screen sizes.
- Moving the status/menu bar to the top reduces the visual impact, but the gap can still appear beneath the rendered terminal rows.

## Expected
- The terminal rows should visually anchor to the bottom of the terminal pane.
- Any unavoidable remainder from whole-row terminal fitting should collect above the visible terminal screen, where it is less noticeable.

## Hypotheses
- `FitAddon` calculates a whole-number row count from the host height. If the host height is not divisible by the xterm cell height, unused remainder pixels remain.
- xterm's injected `.xterm` element is currently top-aligned in the host, so the remainder appears at the bottom.
- A CSS-only bottom anchor on the host's direct `.xterm` child should move the remainder above the xterm screen without changing terminal dimensions or resize messages.

## Proposed Fix
- Keep the terminal host as the same measured `h-full` container for `FitAddon`.
- Make the host a column flex container with bottom alignment for the injected `.xterm` child.
- Update the workbench spec to capture the bottom-anchoring behavior.
