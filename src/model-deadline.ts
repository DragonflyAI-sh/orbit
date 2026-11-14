// Bounded lifetime for one model HTTP request (audit D1). Without it, a provider that never sends headers, stalls mid-stream, or keeps
// streaming forever holds the turn, and with it the thread's busy flag, indefinitely.
//
// Three bounds, all enforced by aborting the request's own AbortController, so the underlying connection and body are released:
// - headersMs: from sending the request until response headers arrive.
// - idleMs: the longest gap between body chunks (also the wait for the first chunk).
// - totalMs: the whole request, headers and body together, however steadily data keeps arriving.
// A caller's AbortSignal, when given, cancels the request too; that is reported as a cancellation, never as a timeout.
// Every timer and listener is removed by end(), which callers run in a `finally` on every exit.

export type Bounds = { headersMs: number; idleMs: number; totalMs: number };

// Injectable for tests; production uses the real clock.
export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const secs = (ms: number) => `${Number((ms / 1000).toFixed(3))} s`;

// The request ran out of time. `phase` says which bound fired. The message names no provider text, only ORBIT's own bound.
export class RequestTimeout extends Error {
  readonly phase: "headers" | "idle" | "total";
  readonly ms: number;
  constructor(phase: "headers" | "idle" | "total", ms: number) {
    super(
      phase === "headers"
        ? `sent no response within ${secs(ms)}`
        : phase === "idle"
          ? `stopped sending its response: no data for ${secs(ms)}`
          : `did not finish its response within ${secs(ms)}`,
    );
    this.name = "RequestTimeout";
    this.phase = phase;
    this.ms = ms;
  }
}

// The caller cancelled the request (its AbortSignal fired). Not a timeout and not a provider failure.
export class RequestCancelled extends Error {
  constructor() {
    super("the request was cancelled by the caller");
    this.name = "RequestCancelled";
  }
}

export type Deadline = {
  // Passed to fetch; aborted when any bound fires or the caller cancels.
  readonly signal: AbortSignal;
  // Sends the request; waits for headers no longer than headersMs (and the total bound).
  fetch(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response>;
  // Reads the whole body as text, no gap longer than idleMs (and the total bound). On any failure the body is cancelled.
  read(res: Response): Promise<string>;
  // Releases a body that will not be read (for example a 401 before a retry).
  discard(res: Response): void;
  // Clears every timer and listener. Safe to call more than once.
  end(): void;
};

export function deadline(bounds: Bounds, opts: { timers?: Timers; signal?: AbortSignal } = {}): Deadline {
  const timers = opts.timers ?? realTimers;
  const ctl = new AbortController();
  let why: RequestTimeout | RequestCancelled | undefined;
  let ended = false;
  let rejectAborted: (e: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => (rejectAborted = reject));
  aborted.catch(() => {});
  const stop = (e: RequestTimeout | RequestCancelled) => {
    if (why || ended) return;
    why = e;
    rejectAborted(e);
    ctl.abort(e);
  };
  let phaseTimer: unknown;
  const clearPhase = () => {
    if (phaseTimer !== undefined) timers.clear(phaseTimer);
    phaseTimer = undefined;
  };
  const arm = (phase: "headers" | "idle", ms: number) => {
    clearPhase();
    phaseTimer = timers.set(() => stop(new RequestTimeout(phase, ms)), ms);
  };
  const totalTimer = timers.set(() => stop(new RequestTimeout("total", bounds.totalMs)), bounds.totalMs);
  const onCaller = () => stop(new RequestCancelled());
  if (opts.signal?.aborted) onCaller();
  else opts.signal?.addEventListener("abort", onCaller, { once: true });

  // Waits for `p`, but gives up as soon as a bound fires or the caller cancels. A failure after that is reported as the bound.
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    if (why) {
      p.catch(() => {});
      throw why;
    }
    try {
      return await Promise.race([p, aborted]);
    } catch (err) {
      throw why ?? err;
    }
  };

  const end = () => {
    if (ended) return;
    ended = true;
    clearPhase();
    timers.clear(totalTimer);
    opts.signal?.removeEventListener("abort", onCaller);
  };

  return {
    signal: ctl.signal,
    async fetch(fetcher, url, init) {
      // Already cancelled or out of time: nothing is sent.
      if (why) throw why;
      arm("headers", bounds.headersMs);
      try {
        return await guard(Promise.resolve().then(() => fetcher(url, { ...init, signal: ctl.signal })));
      } finally {
        clearPhase();
      }
    },
    async read(res) {
      if (!res.body) return "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let out = "";
      arm("idle", bounds.idleMs);
      try {
        for (;;) {
          const { done, value } = await guard(reader.read());
          if (done) break;
          out += decoder.decode(value, { stream: true });
          arm("idle", bounds.idleMs);
        }
        return out + decoder.decode();
      } catch (err) {
        // Stop consuming: the stream's source is cancelled and the connection released.
        reader.cancel(why).catch(() => {});
        if (!why) ctl.abort();
        throw err;
      } finally {
        clearPhase();
      }
    },
    discard(res) {
      res.body?.cancel().catch(() => {});
    },
    end,
  };
}
