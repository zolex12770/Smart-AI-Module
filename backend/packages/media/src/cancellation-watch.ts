/**
 * Turns a persisted cancellation REQUEST into a live signal — docs/26_DECISIONS.md ADR-157.
 *
 * ADR-122 gave every media row a `cancel_requested_at` column and a route to set it, and the
 * workers read it exactly once, before starting. Everything after that point ignored it:
 *
 *  - `processAudioGeneration` takes a `signal`, threads it into `speech.synthesize` and has a
 *    `cancelled` branch — and its one production caller passed three arguments, so the parameter
 *    was always `undefined` and the branch unreachable.
 *  - `VideoProvider.generateVideo` had no signal parameter at all, so the Replicate adapter's
 *    own cancel endpoint — which exists, and which stops a prediction that is still billing —
 *    could not be reached from the platform.
 *
 * Meanwhile the screens offer Cancel for exactly the states those calls run in. A request that
 * is recorded and never acted on is worse than no button: the user believes the spend stopped.
 *
 * Polling rather than listening, because the request arrives in another process (the API role
 * writes the column; the worker role is what is running). The interval is the resolution of the
 * cancellation, not of the job, so a few seconds is right: it bounds the waste without turning a
 * synthesiser call into a database poll loop.
 */
export interface CancellationWatch {
  signal: AbortSignal;
  /** Always call this — it clears the timer and closes the poll. */
  stop(): void;
  /** True once the request was seen, so a caller can settle the row as `cancelled`. */
  wasCancelled(): boolean;
}

export function watchForCancellation(
  isCancelled: () => Promise<boolean>,
  options: { intervalMs?: number; signal?: AbortSignal } = {}
): CancellationWatch {
  const controller = new AbortController();
  let seen = false;

  // An outer signal (a worker shutting down, say) aborts this one too, so a caller has one
  // thing to pass on rather than two.
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const timer = setInterval(() => {
    void isCancelled()
      .then((cancelled) => {
        if (!cancelled || controller.signal.aborted) return;
        seen = true;
        controller.abort();
      })
      // A failed poll is not a cancellation: the work continues, which is the safe direction
      // for a check whose whole purpose is to stop spending.
      .catch(() => undefined);
  }, options.intervalMs ?? 3_000);
  // Never holds the process open during shutdown.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
    wasCancelled: () => seen,
  };
}
