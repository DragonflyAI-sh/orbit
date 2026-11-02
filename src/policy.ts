export type Decision = { allow: boolean; reason: string };

// Fails closed: only a read-only describe passes until real approvals exist.
const ALLOWED_ACTIONS = new Set(["describe"]);

export function decide(port: string, action: string): Decision {
  return ALLOWED_ACTIONS.has(action)
    ? { allow: true, reason: `${action} is read-only` }
    : { allow: false, reason: `${port}.${action} is refused: approvals are not built yet` };
}
