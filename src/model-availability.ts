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
export function modelAvailability(st: PortStatus): ModelAvailability {
  if (st.state === "down") return { available: false, via: "none", reason: st.availability?.available === false ? st.availability.reason : "The model port is down: no reply can come from the primary model or a fallback." };
  if (st.state === "mock") return { available: false, via: "none", reason: "The model is a mock: its answers are not real." };
  if (st.state !== "live" && st.state !== "degraded") return { available: null, via: "unknown", reason: "The model port's state could not be read." };
  const given = st.availability;
  if (given && (given.available === true || given.available === false || given.available === null)) return given;
  if (st.state === "live") return { available: true, via: "primary", reason: "The primary model answers." };
  return { available: true, via: "primary", reason: "The primary model is degraded but expected to answer (not confirmed)." };
}

// The model port entry with its availability set (additive). Other ports are returned as they are.
export function withAvailability(st: PortStatus): PortStatus {
  return st.port === "model" ? { ...st, availability: modelAvailability(st) } : st;
}
