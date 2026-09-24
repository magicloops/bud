/** Test socket for the metadata feed; browser pixels use separate fixtures. */
export class StateSocket {
  static all: StateSocket[] = []
  static autoReady = true
  onmessage: ((event: {data: string}) => void) | null = null
  onclose: ((event: {code: number}) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  url: string
  constructor(url: string) {
    this.url = url; StateSocket.all.push(this)
    if (StateSocket.autoReady) queueMicrotask(() => this.emit('ready'))
  }
  emit(type: string) { if (!this.closed) this.onmessage?.({data: JSON.stringify({type, revision:1})}) }
  close() { this.closed = true; this.onclose?.({code:1000}) }
  static change() { for (const socket of StateSocket.all) socket.emit('changed') }
}
