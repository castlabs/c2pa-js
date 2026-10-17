/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { describe, expect, it, vi } from 'vitest';
import { createLiveValidatorMap } from './liveValidatorMap.js';
import { disposableTx } from './disposableTx.js';

describe('live validator lifecycle', () => {
  it('queues awaited work, drains before free, rejects new work and caches free', async () => {
    const map = createLiveValidatorMap<{ free(): void }>();
    const free = vi.fn();
    const id = map.add({ free });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = map.run(id, async () => {
      order.push('blob-start');
      await gate;
      order.push('blob-end');
    });
    const second = map.run(id, () => {
      order.push('refresh');
    });
    const reset = map.run(id, () => {
      order.push('reset');
    });
    const coverage = map.run(id, () => {
      order.push('coverage');
    });
    const closing = map.free(id);
    expect(map.free(id)).toBe(closing);
    await expect(map.run(id, () => undefined)).rejects.toThrow('closing');
    expect(free).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second, reset, coverage, closing]);
    expect(order).toEqual([
      'blob-start',
      'blob-end',
      'refresh',
      'reset',
      'coverage'
    ]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(map.free(id)).toBe(closing);
    await expect(map.run(id, () => undefined)).rejects.toThrow();
  });

  it('does not poison the queue after rejection or block other validators', async () => {
    const map = createLiveValidatorMap<{ free(): void }>();
    const id = map.add({ free() {} });
    const other = map.add({ free() {} });
    const failure = map.run(id, async () => {
      throw new Error('refresh rejected');
    });
    const later = map.run(id, () => 42);
    await expect(map.run(other, () => 7)).resolves.toBe(7);
    await expect(failure).rejects.toThrow('refresh rejected');
    await expect(later).resolves.toBe(42);
    await map.free(id);
    await map.free(other);
    await expect(map.free(999)).rejects.toThrow('Unknown');
  });

  it('worker disposal rejects admitted and future RPCs, including pending admission', async () => {
    let finish!: (value: number) => void;
    const source = {
      call: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            finish = resolve;
          })
      )
    };
    const managed = disposableTx(source);
    const pending = managed.tx.call();
    await Promise.resolve();
    managed.stop();
    await expect(pending).rejects.toThrow('disposed');
    await expect(managed.tx.call()).rejects.toThrow('disposed');
    finish(1);
    managed.stop();
    expect(source.call).toHaveBeenCalledTimes(1);
  });
});
