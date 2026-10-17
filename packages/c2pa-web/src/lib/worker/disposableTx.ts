/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

/** Reject outstanding and future RPCs when their worker can no longer respond. */
export function disposableTx<T extends object>(source: T) {
  const pending = new Set<(reason: Error) => void>();
  let stopped: Error | undefined;
  const tx = new Proxy(source, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        if (stopped) return Promise.reject(stopped);
        return new Promise((resolve, reject) => {
          pending.add(reject);
          Promise.resolve().then(() => {
            if (stopped) throw stopped;
            return Reflect.apply(method, target, args);
          }).then(resolve, reject).finally(() => pending.delete(reject));
        });
      };
    }
  });
  return {
    tx,
    stop(reason = new Error('C2pa worker disposed')) {
      stopped ??= reason;
      for (const reject of pending) reject(stopped);
      pending.clear();
    }
  };
}
