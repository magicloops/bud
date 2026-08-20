import { chromium } from 'playwright-core'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const SCRATCH = '/private/tmp/claude-501/-Users-adam-bud/13f8ed4f-2cad-4325-8a5a-58ceb7e160d3/scratchpad'
const COOKIE_VALUE = decodeURIComponent(readFileSync(`${SCRATCH}/cookie2.txt`, 'utf8').trim())
const pwCache = `${homedir()}/Library/Caches/ms-playwright`
const chromiumDir = readdirSync(pwCache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop()
const EXECUTABLE = `${pwCache}/${chromiumDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const BUD_ID = 'b_01KM54M7SYPC7GZX0SWBKFE5YP'
const THREAD_ID = 'ba4fd79f-3e1b-4e4d-9a23-f554a7f09026'
const SHOTS = `${SCRATCH}/responsive-shots`
mkdirSync(SHOTS, { recursive: true })

const results = []
const record = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true })

async function makePage(width, height, mobile) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
  })
  await context.addCookies([
    { name: 'better-auth.session_token', value: COOKIE_VALUE, url: 'http://localhost:5173' },
  ])
  const page = await context.newPage()
  await page.goto(`http://localhost:5173/${BUD_ID}/${THREAD_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  return { context, page }
}

const visible = async (page, selector) => {
  const el = page.locator(selector).first()
  if ((await el.count()) === 0) return false
  return el.isVisible()
}

// ---- Phone 390 -------------------------------------------------------------
{
  const { context, page } = await makePage(390, 844, true)

  // Default view is chat: timeline + composer visible, terminal hidden.
  record('phone: composer visible on chat view', await visible(page, 'textarea[name="message"]'))
  const paneHidden = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="terminal-grid-pane"]')
    return !pane || pane.offsetParent === null
  })
  record('phone: terminal hidden on chat view', paneHidden)
  const timelineWidth = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]')
    return ta ? Math.round(ta.getBoundingClientRect().width) : 0
  })
  record('phone: chat column is full width', timelineWidth > 350, `textarea ${timelineWidth}px`)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  record('phone: no horizontal overflow', overflow <= 0, `${overflow}px`)
  await page.screenshot({ path: `${SHOTS}/phone-chat.png` })

  // Switch to terminal view.
  await page.getByRole('button', { name: /terminal/i }).first().click()
  await page.waitForTimeout(800)
  const paneVisible = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="terminal-grid-pane"]')
    return Boolean(pane && pane.offsetParent !== null)
  })
  record('phone: terminal view shows grid pane', paneVisible)
  record(
    'phone: composer hidden outside chat view',
    !(await visible(page, 'textarea[name="message"]')),
  )
  const observer = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="terminal-grid-pane"]')
    const scroller = pane?.querySelector('div.h-full.w-full')
    return scroller ? scroller.className.includes('overflow-auto') : false
  })
  record('phone: grid scroller is pannable (observer mode)', observer)
  await page.screenshot({ path: `${SHOTS}/phone-terminal.png` })

  // Chat tab returns.
  await page.getByRole('button', { name: /chat/i }).first().click()
  await page.waitForTimeout(400)
  record('phone: chat tab returns to chat view', await visible(page, 'textarea[name="message"]'))

  // Thread drawer: hamburger opens overlay with thread list + rail; backdrop closes.
  await page.getByRole('button', { name: 'Toggle thread list' }).click()
  await page.waitForTimeout(600)
  const drawer = await page.evaluate(() => {
    const backdrop = document.querySelector('button[aria-label="Close thread list"]')
    return Boolean(backdrop && backdrop.offsetParent !== null)
  })
  record('phone: hamburger opens thread drawer', drawer)
  await page.screenshot({ path: `${SHOTS}/phone-drawer.png` })
  if (drawer) {
    await page.locator('button[aria-label="Close thread list"]').click({ position: { x: 380, y: 700 } })
    await page.waitForTimeout(400)
    const closed = await page.evaluate(
      () => !document.querySelector('button[aria-label="Close thread list"]'),
    )
    record('phone: backdrop closes drawer', closed)
  }
  await context.close()
}

// ---- Tablet 768 ------------------------------------------------------------
{
  const { context, page } = await makePage(768, 1024, true)
  const both = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]')
    const pane = document.querySelector('[data-testid="terminal-grid-pane"]')
    const taVisible = Boolean(ta && ta.offsetParent !== null)
    const paneVisible = Boolean(pane && pane.offsetParent !== null)
    const paneWidth = pane ? Math.round(pane.getBoundingClientRect().width) : 0
    return { taVisible, paneVisible, paneWidth }
  })
  record('tablet: chat and terminal both visible', both.taVisible && both.paneVisible)
  record('tablet: terminal has real width', both.paneWidth > 300, `${both.paneWidth}px`)
  // Thread panel opens as drawer (overlay) below lg.
  await page.getByRole('button', { name: 'Toggle thread list' }).click()
  await page.waitForTimeout(600)
  const drawer = await page.evaluate(() =>
    Boolean(document.querySelector('button[aria-label="Close thread list"]')),
  )
  record('tablet: thread panel is a drawer', drawer)
  await page.screenshot({ path: `${SHOTS}/tablet-thread.png` })
  await context.close()
}

// ---- Desktop 1400 ----------------------------------------------------------
{
  const { context, page } = await makePage(1400, 900, false)
  const layout = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]')
    const pane = document.querySelector('[data-testid="terminal-grid-pane"]')
    const drawerBackdrop = document.querySelector('button[aria-label="Close thread list"]')
    return {
      taVisible: Boolean(ta && ta.offsetParent !== null),
      paneVisible: Boolean(pane && pane.offsetParent !== null),
      noDrawer: !drawerBackdrop,
      paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : 0,
    }
  })
  record('desktop: chat + terminal side by side', layout.taVisible && layout.paneVisible)
  record('desktop: no drawer backdrop', layout.noDrawer)
  record('desktop: terminal width unchanged-scale', layout.paneWidth > 600, `${layout.paneWidth}px`)
  await page.screenshot({ path: `${SHOTS}/desktop-thread.png` })
  await context.close()
}

await browser.close()
console.log(results.every(Boolean) ? 'ALL PASS' : `FAILURES: ${results.filter((r) => !r).length}`)
process.exit(results.every(Boolean) ? 0 : 1)
