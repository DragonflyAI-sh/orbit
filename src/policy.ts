export type Decision = { allow: boolean; reason: string };

// Fails closed: only reads and chat replies pass until real approvals exist.
const ALLOWED_ACTIONS = new Set(["describe", "chat"]);

export function decide(port: string, action: string): Decision {
  return ALLOWED_ACTIONS.has(action)
    ? { allow: true, reason: `${action} has no effect outside ORBIT` }
    : { allow: false, reason: `${port}.${action} is refused: approvals are not built yet` };
}
