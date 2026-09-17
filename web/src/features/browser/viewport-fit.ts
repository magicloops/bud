export type ViewportSize = { width: number; height: number }
export function paneViewport(width: number, height: number): ViewportSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width: Math.max(240, Math.min(2560, Math.round(width))), height: Math.max(160, Math.min(2560, Math.round(height))) }
}
/** One mutation at a time, one latest desired size, no automatic failure replay. */
export class ViewportFitter {
  private pending: ViewportSize | null = null
  private previous = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private disposed = false
  private apply: (size: ViewportSize) => Promise<void>
  private failed: () => void
  private delay: number
  constructor(apply: (size: ViewportSize) => Promise<void>, failed: () => void, delay = 150) {
    this.apply = apply; this.failed = failed; this.delay = delay
  }
  measure(width: number, height: number) {
    const size = paneViewport(width, height)
    if (!size || this.disposed) return
    const key = `${size.width}:${size.height}`
    if (key === this.previous) return
    this.previous = key
    this.pending = size
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, this.delay)
  }
  private async flush() {
    if (this.disposed || this.running || this.timer || !this.pending) return
    const size = this.pending
    this.pending = null
    this.running = true
    try { await this.apply(size) }
    catch {
      this.pending = null
      this.disposed = true
      if (this.timer) clearTimeout(this.timer)
      this.failed()
    } finally {
      this.running = false
      if (!this.disposed) void this.flush()
    }
  }
  stop() { this.disposed = true; clearTimeout(this.timer); this.pending = null }
}
