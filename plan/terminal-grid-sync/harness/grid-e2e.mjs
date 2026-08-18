// Automated browser validation harness for the grid renderer + predictive
// echo — see ../browser-validation.md for the environment it expects:
//   - dev stack running (service :3000, vite :5173, a daemon owned by the
//     signed-in user with terminal enabled and a SHORT base dir)
//   - a signed session cookie in <scratch>/cookie.txt (better-call signing:
//     HMAC-SHA256 over the session token, STANDARD base64 WITH padding,
//     cookie value URL-encoded) for a user owning BUD_ID
//   - `npm i playwright-core` next to this file + a cached Playwright
//     Chromium (executable path below)
// Run: node grid-e2e.mjs
import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const SCRATCH = '/private/tmp/claude-501/-Users-adam-bud/13f8ed4f-2cad-4325-8a5a-58ceb7e160d3/scratchpad'
const SHOTS = `${SCRATCH}/e2e/shots`
mkdirSync(SHOTS, { recursive: true })

const BUD_ID = 'b_01M0B22EGBB0FPHHZ6TTXV3V3P'
const COOKIE_VALUE = decodeURIComponent(readFileSync(`${SCRATCH}/cookie.txt`, 'utf8').trim())
const threadResp = await fetch('http://localhost:3000/api/threads', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: `better-auth.session_token=${encodeURIComponent(COOKIE_VALUE)}`,
  },
  body: JSON.stringify({ bud_id: BUD_ID, title: 'grid-e2e' }),
})
const THREAD_ID = (await threadResp.json()).thread_id
console.log('thread', THREAD_ID)
const BASE = 'http://localhost:5173'

const EXECUTABLE = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

const results = []
let failures = 0
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitFor(fn, what, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timeout waiting for ${what} (last: ${String(last).slice(0, 200)})`)
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.addCookies([
  { name: 'better-auth.session_token', value: COOKIE_VALUE, url: BASE },
])

const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

const PANE = '[data-testid="terminal-grid-pane"]'
const paneText = () => page.locator(PANE).innerText()

async function typeInPane(text, { enter = true } = {}) {
  await page.locator(PANE).click()
  await page.keyboard.type(text, { delay: 15 })
  if (enter) await page.keyboard.press('Enter')
}

try {
  // ---- 1. Load with the grid renderer flag --------------------------------
  await page.goto(`${BASE}/${BUD_ID}/${THREAD_ID}?renderer=grid`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(PANE, { timeout: 20000 })
  record('grid pane mounts under ?renderer=grid', true)

  // No xterm in grid mode — the whole point of the flag gating.
  const xtermCount = await page.locator('.xterm').count()
  record('xterm is not instantiated in grid mode', xtermCount === 0, `found ${xtermCount}`)

  // A prompt should render from the watch re-arm's full frame.
  await waitFor(async () => /[%$#❯>]/.test(await paneText()), 'shell prompt in grid pane', 25000)
  record('prompt renders from full grid frame', true)
  await page.screenshot({ path: `${SHOTS}/01-prompt.png` })

  // ---- 2. Echo roundtrip ---------------------------------------------------
  await typeInPane('echo grid_e2e_marker_$((40+2))')
  await waitFor(async () => (await paneText()).includes('grid_e2e_marker_42'), 'echo output')
  record('typed command executes and output renders', true)
  await page.screenshot({ path: `${SHOTS}/02-echo.png` })

  // ---- 3. Colors survive as styled runs -----------------------------------
  await typeInPane("printf '\\033[31mREDWORD\\033[0m plain \\033[1;38;5;42mFANCY\\033[0m\\n'")
  await waitFor(async () => (await paneText()).includes('REDWORD'), 'color output')
  const redColor = await page
    .locator(`${PANE} span`)
    .filter({ hasText: /^REDWORD$/ })
    .first()
    .evaluate((el) => getComputedStyle(el).color)
  record('ANSI red renders as a styled run', redColor === 'rgb(205, 49, 49)', redColor)
  const fancy = await page
    .locator(`${PANE} span`)
    .filter({ hasText: /^FANCY$/ })
    .first()
    .evaluate((el) => ({ color: getComputedStyle(el).color, weight: getComputedStyle(el).fontWeight }))
  record(
    '256-color + bold render as styled run',
    fancy.color === 'rgb(0, 215, 135)' && Number(fancy.weight) >= 700,
    JSON.stringify(fancy),
  )
  await page.screenshot({ path: `${SHOTS}/03-colors.png` })

  // ---- 4. Scrollback accumulates from pushes ------------------------------
  await typeInPane('seq 1 120')
  await waitFor(async () => (await paneText()).includes('120'), 'seq tail')
  // Give the final frames a beat, then check an early line scrolled into
  // client scrollback (rendered above the live grid).
  await new Promise((r) => setTimeout(r, 400))
  const textAfterSeq = await paneText()
  const hasEarly = /(^|\n)3(\n|$)/.test(textAfterSeq)
  record('scrolled-off lines accumulate in scrollback', hasEarly, hasEarly ? '' : 'line "3" missing')
  await page.screenshot({ path: `${SHOTS}/04-scrollback.png` })

  // ---- 5. Full-screen TUI (vim) -------------------------------------------
  await typeInPane('vim -u NONE')
  await waitFor(async () => {
    const text = await paneText()
    return ((text.match(/~/g) ?? []).length >= 3) || /N?VIM/.test(text)
  }, 'vim/nvim alt screen', 25000)
  record('vim alt-screen renders (tilde rows)', true)
  await page.keyboard.type('ihello from grid e2e', { delay: 20 })
  await page.keyboard.press('Escape')
  await waitFor(async () => (await paneText()).includes('hello from grid e2e'), 'vim buffer text')
  record('vim insert-mode text renders', true)
  await page.screenshot({ path: `${SHOTS}/05-vim.png` })
  await page.keyboard.type(':q!', { delay: 20 })
  await page.keyboard.press('Enter')
  // The zsh prompt contains '~', so tilde-counting can't detect exit; nvim's
  // status line '[No Name]' is present for the whole vim session and only.
  await waitFor(async () => !(await paneText()).includes('[No Name]'), 'vim exit')
  record('vim exits back to primary screen', true)
  const postVim = await paneText()
  record(
    'scrollback survives the alt-screen round trip',
    postVim.includes('grid_e2e_marker_42'),
    postVim.includes('grid_e2e_marker_42') ? '' : 'pre-vim history missing',
  )
  await page.screenshot({ path: `${SHOTS}/06-post-vim.png` })

  // ---- 6. Reload = reconnect + watch re-arm -------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector(PANE, { timeout: 20000 })
  await waitFor(async () => (await paneText()).includes('grid_e2e_marker_42'), 'history after reload', 25000)
  record('reload re-arms the watch and restores screen + scrollback', true)
  await typeInPane('echo after_reload_$((50+5))')
  await waitFor(async () => (await paneText()).includes('after_reload_55'), 'post-reload echo')
  record('terminal is live after reload', true)
  await page.screenshot({ path: `${SHOTS}/07-after-reload.png` })

  // ---- 7. Byte-path (default) regression ----------------------------------
  const bytesPage = await context.newPage()
  await bytesPage.goto(`${BASE}/${BUD_ID}/${THREAD_ID}`, { waitUntil: 'domcontentloaded' })
  await bytesPage.waitForSelector('.xterm', { timeout: 20000 })
  const gridPaneOnBytes = await bytesPage.locator(PANE).count()
  record('default path still mounts xterm (no grid pane)', gridPaneOnBytes === 0, `grid panes: ${gridPaneOnBytes}`)
  await bytesPage.screenshot({ path: `${SHOTS}/08-bytes-default.png` })
  await bytesPage.close()


  // ---- 8. Resize: server reflow + full frame at the new size --------------
  const resizePage = await context.newPage()
  await resizePage.goto(`${BASE}/${BUD_ID}/${THREAD_ID}?renderer=grid`, { waitUntil: 'domcontentloaded' })
  await resizePage.waitForSelector(PANE, { timeout: 20000 })
  const resizeText = () => resizePage.locator(PANE).innerText()
  await waitFor(async () => (await resizeText()).includes('after_reload_55'), 'second page synced', 25000)
  await resizePage.setViewportSize({ width: 900, height: 600 })
  await new Promise((r) => setTimeout(r, 1200))
  await resizePage.locator(PANE).click()
  await resizePage.keyboard.type('echo resized_ok_$((60+6))', { delay: 15 })
  await resizePage.keyboard.press('Enter')
  await waitFor(async () => (await resizeText()).includes('resized_ok_66'), 'echo after resize')
  record('viewport resize converges and terminal stays live', true)
  await resizePage.screenshot({ path: `${SHOTS}/09-resized.png` })
  await resizePage.close()

  // ---- 9. Output flood ----------------------------------------------------
  await page.locator(PANE).click()
  await page.keyboard.type('seq 1 30000 | tail -5', { delay: 10 })
  await page.keyboard.press('Enter')
  await waitFor(async () => (await paneText()).includes('30000'), 'flood tail', 30000)
  await typeInPane('echo flood_survived_$((70+7))')
  await waitFor(async () => (await paneText()).includes('flood_survived_77'), 'echo after flood')
  record('30k-line flood does not wedge the renderer', true)
  await typeInPane('seq 1 5000')
  await waitFor(async () => (await paneText()).includes('5000'), 'raw flood tail', 30000)
  await typeInPane('echo raw_flood_ok_$((80+8))')
  await waitFor(async () => (await paneText()).includes('raw_flood_ok_88'), 'echo after raw flood')
  record('raw 5k-line scroll flood stays live with scrollback', true)
  await page.screenshot({ path: `${SHOTS}/10-flood.png` })

  // ---- 10. Ctrl+C interrupt ----------------------------------------------
  await typeInPane('sleep 300')
  await new Promise((r) => setTimeout(r, 600))
  await page.keyboard.press('Control+c')
  await typeInPane('echo interrupted_ok_$((90+9))')
  await waitFor(async () => (await paneText()).includes('interrupted_ok_99'), 'echo after ctrl+c')
  record('ctrl+c interrupts a running command', true)
  await page.screenshot({ path: `${SHOTS}/11-interrupt.png` })


  // ---- 11. Predictive echo (phase 3) --------------------------------------
  // Add real network latency via CDP so the server ack lags the keystroke:
  // the ghost must render locally first, then reconcile away.
  const predictPage = await context.newPage()
  await predictPage.goto(`${BASE}/${BUD_ID}/${THREAD_ID}?renderer=grid`, { waitUntil: 'domcontentloaded' })
  await predictPage.waitForSelector(PANE, { timeout: 20000 })
  const predictText = () => predictPage.locator(PANE).innerText()
  await waitFor(async () => /[%$#]/.test(await predictText()), 'prompt on predict page', 25000)
  const cdp = await context.newCDPSession(predictPage)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 300,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await predictPage.locator(PANE).click()
  await predictPage.keyboard.type('echo ghost_train', { delay: 5 })
  // Ghost appears locally long before the 300ms-late ack can retire it.
  const ghost = predictPage.locator('[data-testid="terminal-prediction"]')
  await waitFor(async () => (await ghost.count()) > 0 && (await ghost.innerText()).includes('ghost_train'), 'prediction ghost', 3000)
  record('predictive ghost renders before server echo', true)
  await predictPage.screenshot({ path: `${SHOTS}/12-prediction.png` })
  // Reconciliation: the ack retires the ghost and the authoritative echo
  // carries the same text.
  await waitFor(async () => (await ghost.count()) === 0, 'ghost retired', 10000)
  await waitFor(async () => (await predictText()).includes('echo ghost_train'), 'authoritative echo')
  record('ghost reconciles into authoritative echo', true)
  await predictPage.keyboard.press('Enter')
  await waitFor(async () => {
    const text = await predictText()
    return text.split('ghost_train').length >= 3 // command line + output line
  }, 'predicted command executes', 10000)
  record('predicted command executes normally', true)

  // Gate: no predictions while a foreground command runs.
  await predictPage.keyboard.type('sleep 2', { delay: 5 })
  await predictPage.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 900))
  await predictPage.keyboard.type('zzz', { delay: 5 })
  await new Promise((r) => setTimeout(r, 200))
  const ghostDuringCommand = await ghost.count()
  record('no ghosts while a command is running (predict gate)', ghostDuringCommand === 0, `ghost count ${ghostDuringCommand}`)
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await waitFor(async () => /zzz/.test(await predictText()), 'typed-through text lands after sleep', 15000)
  await predictPage.keyboard.press('Enter')
  await predictPage.close()

  const fatal = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('404') && !e.includes('WebSocket'),
  )
  record('no unexpected browser console errors', fatal.length === 0, fatal.slice(0, 3).join(' | '))
} catch (err) {
  record('harness completed', false, String(err).slice(0, 300))
  await page.screenshot({ path: `${SHOTS}/99-failure.png` }).catch(() => {})
} finally {
  await browser.close()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
