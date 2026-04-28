type Waiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
};

export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private values: T[] = [];
  private waiters: Waiter<T>[] = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.failure) {
      return;
    }

    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
