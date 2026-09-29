// Source experiment only. The caller supplies an owned target and admission;
// CDP focus/visibility never grants permission to deliver pixels or send input.
export class PrivateCapture {
  #live = false;
  #retiring;
  #timer;
  #session;
  #setup;
  constructor(source, target, admitted, frame) {
    this.source = source;
    this.target = target;
    this.admitted = admitted;
    this.frame = frame;
    this.failure = null;
    this.onEvent = event => {
      if (event.sessionId !== this.#session || event.method !== 'Page.screencastFrame') return;
      // Source ACKs remain independent of consumer delivery, including retirement.
      source.call('Page.screencastFrameAck', { sessionId: event.params.sessionId }, this.#session)
        .catch(() => { void this.stop('source_ack_failed'); });
      if (this.#live && admitted()) this.frame(event.params);
      else if (this.#live) void this.stop('admission_lost');
    };
    this.onEnd = () => { void this.stop('source_lost'); };
    source.on('event', this.onEvent);
    source.on('ended', this.onEnd);
  }
  start() {
    if (this.#setup || this.#retiring) throw new Error('capture_already_started');
    if (!this.admitted()) throw new Error('capture_not_admitted');
    this.#live = true;
    this.#timer = setInterval(() => {
      if (!this.admitted()) void this.stop('admission_lost');
    }, 25);
    this.#setup = (async () => {
      this.#session = await this.source.attach(this.target);
      if (!this.#live || !this.admitted()) return;
      await this.source.call('Emulation.setFocusEmulationEnabled', { enabled: true }, this.#session);
      if (!this.#live || !this.admitted()) return;
      await this.source.call('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 440, maxHeight: 816, everyNthFrame: 1 }, this.#session);
    })();
    return this.#setup.then(async () => {
      if (!this.#live || !this.admitted()) {
        await this.stop('admission_lost');
        throw new Error('capture_not_admitted');
      }
    }, async error => {
      await this.stop('setup_failed');
      throw error;
    });
  }
  stop(reason = 'retired') {
    // Fence synchronously, before waiting for an in-flight setup command.
    this.#live = false;
    clearInterval(this.#timer);
    if (this.#retiring) return this.#retiring;
    this.reason = reason;
    this.#retiring = (async () => {
      await this.#setup?.catch(() => {});
      if (this.#session) {
        for (const [method, params] of [
          ['Page.stopScreencast', {}],
          ['Emulation.setFocusEmulationEnabled', { enabled: false }],
        ]) {
          await this.source.call(method, params, this.#session, 1000)
            .catch(() => { this.failure ??= 'cleanup_unconfirmed'; });
        }
      }
      this.source.off('event', this.onEvent);
      this.source.off('ended', this.onEnd);
      this.source.close();
    })();
    return this.#retiring;
  }
}
