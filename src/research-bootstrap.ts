import type { BootstrapFailure } from "./jobs.ts";

// A research runner's bootstrap: the routine prompt (deploy/routines/orbit-research.md, step 2) downloads the runner tool from the job
// API (GET /v1/jobs/<id>/tool), checks its sha256 against the fire text and only then installs it. That step has no tool yet, so it cannot
// use the tool's check-ins. When it fails, it may try ONE report back to ORBIT on the existing, authenticated events route with this job's
// token: `{"type":"bootstrap","category":..,"attempts":..,"curlExit":..,"http":..}`. Delivery is best effort and often impossible (the
// same network failure that stopped the download can stop the report), so the absence of a report proves nothing: a silent job is shown
// as not checked in after the documented deadline (src/jobs.ts health "not-started"), never as failed or never launched.
//
// The listener accepts only these fixed categories and bounded integers, and writes the event text itself: no runner-supplied free text
// is stored. A report is accepted only for a research job, only with its own token, and only before the runner's tool has started.

// The categories the prompt's bootstrap prints, and whether the bootstrap retries them (bounded: at most 4 attempts, backoff 2, 4, 8 s,
// about 150 s in all). Kept in step with the prompt by test/research-bootstrap.test.ts.
export const BOOTSTRAP_CATEGORIES = {
  // Transport failures of an idempotent GET: retried.
  dns: { retried: true, meaning: "the host name (or the proxy's) could not be resolved (curl 5 or 6)" },
  "connect-failed": { retried: true, meaning: "the TCP connection was refused or could not be made (curl 7)" },
  timeout: { retried: true, meaning: "the connection or the transfer ran past its time limit (curl 28)" },
  "tls-connect": { retried: true, meaning: "the TLS handshake broke off, for example a connection reset by the peer during it (curl 35)" },
  "connection-reset": { retried: true, meaning: "the connection was reset, closed or broke off after it was set up (curl 52, 55, 56, 18, 92)" },
  "proxy-connect": { retried: true, meaning: "the sandbox's HTTPS proxy did not open the tunnel and did not refuse it outright (curl 56 'CONNECT tunnel failed', other than 403 or 407)" },
  "rate-limited": { retried: true, meaning: "ORBIT answered 429 (60 requests a minute per job)" },
  "server-error": { retried: true, meaning: "an HTTP 5xx answer (from ORBIT, or from the network path in front of it)" },
  // Not transient, or not safe to repeat: never retried.
  "auth-denied": { retried: false, meaning: "ORBIT answered 401 or 403: a wrong, expired or finished job's token (the same answer as no token)" },
  "not-found": { retried: false, meaning: "ORBIT answered 404: not a research job, or the path is wrong" },
  "http-unexpected": { retried: false, meaning: "any other HTTP answer, including a redirect (never followed: it could carry the token elsewhere)" },
  "tls-verify": { retried: false, meaning: "the server certificate could not be verified (curl 51, 58, 59, 60, 77, 83, 90, 91); never bypassed" },
  "proxy-denied": { retried: false, meaning: "the sandbox's HTTPS proxy refused the tunnel (403 or 407): the environment's network policy, not a transient fault" },
  "digest-mismatch": { retried: false, meaning: "the download did not match the fire text's Tool sha256; it was deleted, never run" },
  "curl-error": { retried: false, meaning: "any other curl failure" },
  "local-error": { retried: false, meaning: "the sandbox could not create the private work directory or install the tool" },
} as const;
export type BootstrapCategory = keyof typeof BOOTSTRAP_CATEGORIES;
export const BOOTSTRAP_MAX_ATTEMPTS = 4;

// Reads a bootstrap report body. Anything outside the contract is refused whole (400), never coerced.
export function parseBootstrapReport(body: Record<string, unknown>): { ok: true; report: BootstrapFailure; text: string } | { ok: false; problem: string } {
  const { category, attempts, curlExit, http } = body;
  if (typeof category !== "string" || !Object.hasOwn(BOOTSTRAP_CATEGORIES, category)) return { ok: false, problem: `category must be one of: ${Object.keys(BOOTSTRAP_CATEGORIES).join(", ")}` };
  const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(attempts, 0, 10)) return { ok: false, problem: "attempts must be an integer from 0 to 10" };
  if (!int(curlExit, 0, 255)) return { ok: false, problem: "curlExit must be an integer from 0 to 255" };
  if (!int(http, 0, 599)) return { ok: false, problem: "http must be an integer from 0 to 599 (0: no HTTP answer)" };
  const report: BootstrapFailure = { category, attempts: attempts as number, curlExit: curlExit as number, http: http as number };
  return { ok: true, report, text: bootstrapText(report) };
}

export function bootstrapText(r: BootstrapFailure): string {
  const c = BOOTSTRAP_CATEGORIES[r.category as BootstrapCategory];
  return `the runner reported a bootstrap failure before its tool ran: ${r.category} after ${r.attempts} attempt(s) (curl exit ${r.curlExit}, HTTP ${r.http === 0 ? "none" : r.http})${c ? `: ${c.meaning}` : ""}.`;
}
