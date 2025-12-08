# Debug: xterm "Cannot read properties of undefined (reading 'dimensions')"

## Environment
- OS: macOS Darwin 24.1.0
- Node: 20+
- xterm.js: 5.3.0
- xterm-addon-fit: 0.8.0
- Vite dev server with HMR

## Repro steps
1. Start the web dev server (`npm run dev`)
2. Open the app in browser
3. Error appears immediately on page load

## Observed
```
Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')
    at get dimensions (xterm.js?v=d4144f99:1776:41)
    at t2.Viewport._innerRefresh (xterm.js?v=d4144f99:821:60)
    at xterm.js?v=d4144f99:817:150
```

Stack trace shows the error originates from:
- `fit @ xterm-addon-fit.js:25`
- Called from `App.tsx:166` (inside `fitTerminal`)
- Also from `App.tsx:245` (the `useEffect` that calls `fitTerminal` on `threadPanelOpen` change)

The error occurs during React's `commitHookPassiveMountEffects` phase, indicating it happens during effect execution on mount.

## Expected
Terminal should initialize without errors and fit to container.

## Current Implementation

### fitTerminal (lines 158-176)
- Has guards for `addon`, `term`, `pane`, `pane.isConnected`, `term.element`
- Added guard for `renderService?.dimensions`
- Wraps `addon.fit()` in try/catch

### Terminal initialization effect (lines 193-259)
- Creates Terminal, loads FitAddon, calls `term.open(container)`
- Uses `requestAnimationFrame` + retry loop (up to 10 attempts) checking `renderService?.dimensions`
- Only calls `fitTerminal()` after dimensions are available

### threadPanelOpen effect (lines 261-263)
- Calls `fitTerminal()` directly when `threadPanelOpen` changes
- **No guard for terminal readiness**

## Hypotheses

### H1: The `threadPanelOpen` effect runs before terminal is ready
The effect at line 261-263 runs on mount (due to `fitTerminal` in deps) and calls `fitTerminal()` immediately. Even though `fitTerminal` has guards, the error happens *inside* xterm's internal code path before our guard can prevent it.

**Evidence**: Stack trace shows error originates from `App.tsx:245` which is line 262 (`fitTerminal()`).

**Test**: Add logging to see the order of effect execution and whether the terminal init effect completes before the threadPanelOpen effect.

### H2: FitAddon.fit() triggers internal xterm operations that bypass our dimension check
Our guard checks `renderService?.dimensions`, but `addon.fit()` may trigger a chain of internal xterm calls that access dimensions through a different code path that we're not guarding.

**Evidence**: The error is thrown from `Viewport._innerRefresh` and `Viewport.syncScrollArea`, which are internal xterm methods triggered by fit/resize operations.

**Test**: Wrap `addon.fit()` check with a more comprehensive readiness test, or defer fit until xterm emits a "ready" event (if one exists).

### H3: React Strict Mode double-invokes effects, causing race condition
In development, React Strict Mode mounts/unmounts/remounts components. The terminal may be disposed and then accessed.

**Evidence**: The cleanup function disposes the terminal and nulls the refs, but another effect might still hold a stale reference.

**Test**: Check if the error persists with Strict Mode disabled.

### H4: The FitAddon itself needs initialization time after loading
`term.loadAddon(fitAddon)` is called, then immediately `term.open(container)`. The FitAddon may need the terminal to be open AND rendered before it can safely call `fit()`.

**Evidence**: xterm-addon-fit's `fit()` method internally accesses terminal dimensions which require the DOM to be rendered.

**Test**: Use `setTimeout` or wait for xterm's `onRender` event before first fit call.

### H5: Multiple effects compete to call fitTerminal simultaneously
Both the terminal init effect (via `tryFit`) and the `threadPanelOpen` effect call `fitTerminal()`. If they run in the same frame or overlapping frames, xterm's internal state may be inconsistent.

**Evidence**: Both effects have `fitTerminal` in their dependency arrays, so both run on mount.

**Test**: Add a ref-based "fitting in progress" lock, or consolidate fit calls into a single effect.

## Proposed investigation order
1. **H1** - Most likely given the stack trace points to line 262
2. **H5** - Related to H1, multiple simultaneous fit calls
3. **H2** - The guard may be insufficient
4. **H4** - Timing issue with addon initialization
5. **H3** - Less likely but easy to test

## Investigation Round 1: H1 + H5

### Changes made
1. Added `terminalReadyRef` - a ref that tracks whether xterm is fully initialized
2. `fitTerminal()` now returns early if `terminalReadyRef.current === false`
3. The terminal init effect sets `terminalReadyRef.current = true` only after confirming `renderService?.dimensions` exists
4. Cleanup sets `terminalReadyRef.current = false`

### Result
- **Reduced from 2+ errors to 1 error**
- Error still occurs once on page load

### Analysis
H1 and H5 were partially correct - the `terminalReadyRef` guard prevents most premature `fitTerminal` calls. But one error still slips through.

The remaining error likely comes from:
- The `tryFit` loop itself when it calls `fitTerminal()` after detecting dimensions
- Or some other code path we haven't guarded

### Remaining stack trace
```
Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')
    at get dimensions (xterm.js?v=d4144f99:1776:41)
    at t2.Viewport._innerRefresh (xterm.js?v=d4144f99:821:60)
    at xterm.js?v=d4144f99:817:150
```

Note: This stack trace does NOT show `fit @ xterm-addon-fit.js` - it's triggered by `Viewport._innerRefresh` directly, suggesting it's an internal xterm operation, not our `fitTerminal()` call.

---

## Updated Hypotheses

### H2 (revised): xterm triggers internal refresh before fully ready
The error comes from `Viewport._innerRefresh`, which is called internally by xterm (not by our code). This happens during xterm's own initialization or when we call `term.open()`.

**Evidence**: Stack trace no longer shows `addon.fit()` or our code - it's purely internal xterm calls.

**Test**: Check if error occurs even without any `fitTerminal()` calls.

### H3 (elevated): React Strict Mode causes double mount/unmount
React 18 Strict Mode in development intentionally double-invokes effects. The sequence might be:
1. Mount → create terminal → start tryFit loop
2. Unmount (Strict Mode) → dispose terminal, null refs
3. Remount → create new terminal
4. Old tryFit loop callback fires with stale/disposed terminal reference

**Evidence**: The error happens during initialization. Strict Mode is known to cause issues with imperative DOM APIs like xterm.

**Test**: Disable Strict Mode or check if `current === terminalRef.current` guard is sufficient.

### H6 (new): The `term.open()` call triggers viewport refresh before renderer is ready
When `term.open(container)` is called, xterm may internally trigger `Viewport._innerRefresh` before the render service is fully initialized.

**Evidence**: Error happens at `:817:150` which is likely inside xterm's open/attach logic, not our fit calls.

**Test**: Wrap `term.open()` in a try/catch or defer it with requestAnimationFrame.

## Investigation Round 2: H3 (React Strict Mode)

### Changes made
1. Added `disposed` flag set to `true` at start of cleanup
2. Check `disposed` after `term.open()` and bail early if true
3. Check `disposed` in all callbacks: `tryFit`, `handleResize`, `dataListener`, `scrollListener`
4. Use `terminalRef.current !== term` check for stale reference detection

### Result
- **Error still occurs once on page load**
- The `disposed` flag approach did NOT fix the issue

### Analysis
The error is NOT caused by our code accessing a disposed terminal. The stack trace shows:
```
at t2.Viewport._innerRefresh (xterm.js:821:60)
at xterm.js:817:150
```

This is xterm's internal code, not triggered by `addon.fit()` or any of our guarded calls. The error happens during xterm's own initialization sequence, likely triggered by `term.open(container)`.

Key observation: The guard at line 192 `if (!terminalPaneRef.current || terminalRef.current)` should prevent double-initialization, but with React Strict Mode:
1. First mount: `terminalRef.current` is null → creates terminal
2. Cleanup: disposes terminal, sets `terminalRef.current = null`
3. Second mount: `terminalRef.current` is null again → creates NEW terminal

Both terminals are created, and the first one's internal async operations may still be running when it gets disposed.

---

## Updated Hypotheses

### H6 (primary): `term.open()` schedules internal async work that fails after disposal
When `term.open(container)` is called, xterm schedules internal `requestAnimationFrame` or microtask callbacks for viewport initialization. When the terminal is disposed (React Strict Mode cleanup), these internal callbacks still fire and access disposed/undefined state.

**Evidence**:
- Error is from `Viewport._innerRefresh`, an internal xterm method
- Our `disposed` flag doesn't help because xterm's internal callbacks don't check it
- Error happens regardless of whether we call `fit()` or not

**Test**: Comment out ALL xterm initialization and see if error disappears. Then add back just `new Terminal()` and `term.open()` without any fit/listener code.

### H7 (new): The container element is removed from DOM before xterm finishes initializing
React Strict Mode unmounts the component, which removes the container div from the DOM. xterm's internal viewport refresh tries to access the container's dimensions but it's no longer in the DOM.

**Evidence**:
- `Viewport._innerRefresh` likely accesses container dimensions
- React Strict Mode removes elements during cleanup phase

**Test**: Check if wrapping terminal in a persistent container (outside React's control) helps.

### H8 (new): xterm 5.3.0 has a known React Strict Mode incompatibility
xterm.js may not be designed to handle rapid mount/unmount cycles.

**Evidence**: This is a common issue with imperative libraries in React 18 Strict Mode.

**Test**: Search xterm.js GitHub issues for "Strict Mode" or "dimensions undefined".

## Investigation Round 3: Strict Mode ruled out

### Test
Disabled React Strict Mode in main.tsx

### Result
Error still occurs - **Strict Mode is NOT the cause**

### New direction
Found similar issues on GitHub. The problem appears to be that xterm is initialized before the DOM container is fully ready/sized. Solutions seen in the wild:
- Dynamic import of xterm (defer loading until component mounts)
- Wait for container to have dimensions before calling `term.open()`
- Use `requestAnimationFrame` or `setTimeout` to defer `term.open()`

## Resolution

### Root Cause
xterm.js was being initialized before the DOM container had rendered with proper dimensions. When `term.open(container)` is called on a container with zero width/height, xterm's internal `Viewport._innerRefresh` method tries to access `renderService.dimensions` which is undefined because the renderer couldn't initialize without valid container dimensions.

### Fix
Two changes in the terminal initialization effect:

1. **Dynamic import** - Changed from static `import { Terminal } from 'xterm'` to dynamic `import('xterm')` inside the useEffect. This defers xterm loading until after React has mounted the component and the DOM is ready.

2. **Wait for container dimensions** - Added a check that waits for `container.getBoundingClientRect()` to return non-zero width and height before calling `term.open()`:
   ```typescript
   await new Promise<void>((resolve) => {
     const check = () => {
       const rect = container.getBoundingClientRect()
       if (rect.width > 0 && rect.height > 0) {
         resolve()
       } else {
         requestAnimationFrame(check)
       }
     }
     check()
   })
   ```

3. **Cancellation handling** - Added `cancelled` flag checked at multiple points in the async flow to handle cleanup during initialization.

### Outcome
Error no longer occurs. Terminal initializes cleanly after the container is properly sized.
