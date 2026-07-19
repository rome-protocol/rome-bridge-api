/**
 * Wrap a fetch with a default AbortSignal.timeout so a hung upstream socket
 * (iris, wormholescan, registry raw fetch, sponsor→API) can never stall a
 * poller tick indefinitely. A caller-provided signal wins; the timeout signal
 * is combined so whichever fires first aborts.
 */
export function withTimeout(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetchFn(input, { ...init, signal });
  }) as typeof fetch;
}
