import type { ApiThread, ApiThreadListPage } from '../../lib/api-types'
import { compareThreads } from '../../lib/thread-order.ts'

export type ThreadListPatch = { event: 'upsert' | 'remove'; epoch: string; sequence: number;
  thread?: ApiThread; thread_id?: string }

/** One bounded window. Checkpoints describe feed ordering, not database revisions. */
export class ThreadListWindow {
  rows: ApiThread[] = []
  checkpoint: ApiThreadListPage['feed_checkpoint'] | null = null
  private pending: ThreadListPatch[] = []
  private reading = false
  readonly budId: string
  readonly before: ApiThread | null
  limit: number
  constructor(budId: string, limit = 50, before: ApiThread | null = null) {
    this.budId = budId; this.limit = limit; this.before = before
  }
  begin(): void { this.reading = true; this.pending = [] }
  snapshot(page: ApiThreadListPage): boolean {
    this.rows = page.threads.filter(row => row.bud_id === this.budId).sort(compareThreads).slice(0, this.limit)
    const count = this.rows.length
    this.checkpoint = page.feed_checkpoint
    this.reading = false
    for (const patch of this.pending) this.apply(patch)
    this.pending = []
    return this.rows.length < count
  }
  patch(patch: ThreadListPatch): boolean {
    if (this.reading) {
      if (this.pending.length >= 128) throw new Error('thread_list_overflow')
      this.pending.push(patch); return false
    }
    const before = this.rows.length
    this.apply(patch)
    return this.rows.length < before
  }
  private apply(patch: ThreadListPatch): void {
    if (!this.checkpoint || this.checkpoint.epoch !== patch.epoch) throw new Error('thread_list_epoch_changed')
    if (patch.sequence <= this.checkpoint.sequence) return
    if (patch.sequence !== this.checkpoint.sequence + 1) throw new Error('thread_list_gap')
    const id = patch.event === 'upsert' ? patch.thread?.thread_id : patch.thread_id
    if (!id) throw new Error('thread_list_invalid_patch')
    this.rows = this.rows.filter(row => row.thread_id !== id)
    if (patch.event === 'upsert' && patch.thread?.bud_id === this.budId &&
      (!this.before || compareThreads(patch.thread, this.before) > 0)) this.rows.push(patch.thread)
    this.rows.sort(compareThreads)
    this.rows = this.rows.slice(0, this.limit)
    this.checkpoint = { epoch: patch.epoch, sequence: patch.sequence }
  }
}
