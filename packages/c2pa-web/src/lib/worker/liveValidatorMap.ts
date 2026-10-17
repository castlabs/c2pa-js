/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

/** Queues operations at receipt, before any asynchronous Blob/refresh work. */
export function createLiveValidatorMap<T extends { free(): void }>() {
  let nextId = 0;
  const entries = new Map<number, { value: T; tail: Promise<unknown>; closing?: Promise<void> }>();
  // Tombstones make duplicate free idempotent without retaining WASM objects.
  const frees = new Map<number, Promise<void>>();

  return {
    add(value: T): number {
      const id = nextId++;
      entries.set(id, { value, tail: Promise.resolve() });
      return id;
    },
    run<R>(id: number, operation: (value: T) => R | Promise<R>): Promise<R> {
      const entry = entries.get(id);
      if (!entry || entry.closing) return Promise.reject(new Error('Unknown or closing live validator'));
      const result = entry.tail.then(() => operation(entry.value));
      entry.tail = result.then(() => undefined, () => undefined);
      return result;
    },
    free(id: number): Promise<void> {
      const previous = frees.get(id);
      if (previous) return previous;
      const entry = entries.get(id);
      if (!entry) return Promise.reject(new Error('Unknown live validator'));
      entry.closing = entry.tail.then(() => {
        try { entry.value.free(); } finally { entries.delete(id); }
      });
      frees.set(id, entry.closing);
      return entry.closing;
    }
  };
}
