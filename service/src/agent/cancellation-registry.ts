export class AgentCancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  set(threadId: string, controller: AbortController): void {
    this.controllers.set(threadId, controller);
  }

  get(threadId: string): AbortController | undefined {
    return this.controllers.get(threadId);
  }

  clear(threadId: string): void {
    this.controllers.delete(threadId);
  }

  cancel(threadId: string): AbortController | undefined {
    const controller = this.controllers.get(threadId);
    if (!controller) {
      return undefined;
    }
    controller.abort();
    this.controllers.delete(threadId);
    return controller;
  }

  has(threadId: string): boolean {
    return this.controllers.has(threadId);
  }
}

