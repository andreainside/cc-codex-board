// Tiny async TTL memoizer. Used to throttle git/gh calls (and the whole board)
// so rapid browser polling does not hammer the GitHub API.

/**
 * @template T
 * @param {(...args:any[])=>Promise<T>} fn
 * @param {{ttlMs:number, now?:()=>number, keyFn?:(...args:any[])=>string}} opts
 * @returns {(...args:any[])=>Promise<T>}
 */
export function memoizeAsync(fn, { ttlMs, now = () => Date.now(), keyFn } = {}) {
  const cache = new Map(); // key -> { value, expires }
  const inflight = new Map(); // key -> Promise (dedupe concurrent calls)

  return async function memoized(...args) {
    const key = keyFn ? keyFn(...args) : JSON.stringify(args);
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expires > t) return hit.value;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const value = await fn(...args);
      cache.set(key, { value, expires: now() + ttlMs });
      return value;
    })();
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  };
}
