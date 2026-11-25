import type { ModelAvailability, PortStatus } from "./ports.ts";

// Effective model availability: can a real reply come from some model right now? It is separate from process health (a /status
// answer at all shows the ORBIT process is running) and from `state`, which keeps its four values and meaning. /status sets it on the
// model port; the page's overall indicator reads it first (src/web/index.html, "status-dot"; docs/assistant.md, "Overall status").
//
// The OpenRouter fallback wrapper (src/fallback.ts) sets it itself while a primary limit is recorded, from what it actually knows:
// the paid route's usability and the outcome of its latest call. For every other model status it is derived from `state` here:
//   live      true   (the primary answers)
//   degraded  true   (nonfatal: the primary is expected to answer but is not confirmed, e.g. a token not renewed yet or a limit that
//                    has passed with no call since). Amber, not green.
//   down      false  no model can reply
//   mock      false  a mock is not a real reply
//   anything else    null (not known), never true
// Whatever the wrapper said, a `down` or `mock` state is never reported available, and an unreadable state is never more than null.
//
// Model health (src/model-health.ts, docs/model-health.md) is read too. When the tracker's state is `fallback` (the latest evidence, from
// the post-deploy smoke check or a real call, is a ChatGPT usage or rate limit) and the port is otherwise live or degraded, ORBIT IS in
// fallback, which is a known, working-but-degraded state, not an unknown one:
//   - the wrapper reports the limit and a usable fallback it has not called yet (it said null): available true via the fallback,
//     with a reason that says plainly ChatGPT is at its limit, the OpenRouter fallback takes the replies, and it is not confirmed yet;
//   - the limit is not recorded by the port in this process yet (for example right after a deploy, before the smoke check has answered,
//     while ChatGPT's local login check says live): `state` becomes `degraded` (withAvailability) and available true via the primary,
//     with the tracker's reason, since the next call tries ChatGPT first.
// A wrapper verdict of true or false is kept (it is evidence about the route itself), and `down`/`mock` still win. `unknown` health
// (nothing recorded yet) changes nothing.
export function modelAvailability(st: PortStatus): ModelAvailability {
  if (st.state === "down") return { available: false, via: "none", reason: st.availability?.available === false ? st.availability.reason : "The model port is down: no reply can come from the primary model or a fallback." };
  if (st.state === "mock") return { available: false, via: "none", reason: "The model is a mock: its answers are not real." };
  if (st.state !== "live" && st.state !== "degraded") return { available: null, via: "unknown", reason: "The model port's state could not be read." };
  const given = st.availability;
  const known = !!given && (given.available === true || given.available === false || given.available === null);
  if (st.health?.state === "fallback" && !(known && given!.available !== null)) return inFallback(st);
  if (known) return given!;
  if (st.state === "live") return { available: true, via: "primary", reason: "The primary model answers." };
  return { available: true, via: "primary", reason: "The primary model is degraded but expected to answer (not confirmed)." };
}

// ORBIT is in fallback (the health tracker says so) and the port is live or degraded: say so in words that are accurate and actionable.
function inFallback(st: PortStatus): ModelAvailability {
  const h = st.health!;
  const fb = st.fallback;
  if (fb) {
    const limit = fb.reason === "rate_limit" ? "ChatGPT is rate limiting requests" : "ChatGPT is at its usage limit";
    const until = `until ${fb.until}${fb.estimated ? " (ORBIT's estimate)" : ""}`;
    const confirmed = fb.lastCall === "succeeded" ? "it answered the latest call" : "it has not been called since the limit began, so it is not confirmed yet";
    return { available: true, via: "fallback", reason: `${limit}; using the OpenRouter fallback (${fb.model}) ${until}: ${confirmed}.` };
  }
  const evidence = `${h.source === "smoke" ? "the post-deploy smoke check" : h.source === "call" ? "a model call" : "the model health record"} at ${h.at}`;
  return {
    available: true,
    via: "primary",
    reason: `ORBIT is in fallback: ${h.reason ? h.reason.replace(/\.$/, "") : "the latest evidence is a ChatGPT usage or rate limit"} (${evidence}). The limit is not recorded in this process yet, so the next call tries ChatGPT first; it is not confirmed which model answers.`,
  };
}

// The model port entry with its availability set (additive). Other ports are returned as they are. While the health tracker says
// `fallback`, a `live` model port is reported `degraded`: a local login check is not evidence that ChatGPT answers past its limit.
export function withAvailability(st: PortStatus): PortStatus {
  if (st.port !== "model") return st;
  const s: PortStatus = st.health?.state === "fallback" && st.state === "live" ? { ...st, state: "degraded", detail: `In fallback (model health): ${st.health.reason ?? "the latest evidence is a ChatGPT limit"}. ${st.detail}` } : st;
  return { ...s, availability: modelAvailability(s) };
}
