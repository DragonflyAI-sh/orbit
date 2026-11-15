// Synthetic "Slate Heron" conversation for test/session-durability.test.ts and its child process. Invented values only: no real
// conversation, vault note or person. Long enough that a default session_read page holds only a few messages, with the facts on the
// first page, two successive corrections of one fact on later pages, two facts that never change, and no approval anywhere.

export const TITLE = "Durability test — Slate Heron";
export const FACTS = "Slate Heron project facts. Please keep these: build tag SH-4471, review channel amber, deploy window Monday at 09:15 UTC.";
export const CORRECTION_1 = "Correction: the deploy window is now Tuesday at 11:30 UTC. Build tag and review channel stay the same.";
export const CORRECTION_2 = "Second correction: the deploy window is now Wednesday at 15:45 UTC. Build tag and review channel stay the same.";
export const WINDOWS = ["Monday at 09:15 UTC", "Tuesday at 11:30 UTC", "Wednesday at 15:45 UTC"];

const log = (k: number) => {
  const lines: string[] = [];
  for (let j = 0; j < 8; j++) lines.push(`Log entry ${k}, line ${j}: routine synthetic status for the durability check, nothing to act on.`);
  return lines.join("\n");
};

// users[i] is the i-th user message; reply(text) is what the scripted chat model answers to it.
export function durabilityConversation() {
  const users: string[] = [FACTS];
  for (let k = 1; k <= 12; k++) {
    users.push(log(k));
    if (k === 5) users.push(CORRECTION_1);
    if (k === 10) users.push(CORRECTION_2);
  }
  const reply = (text: string) => {
    const m = /^Log entry (\d+),/.exec(text);
    return m ? `Logged entry ${m[1]}.` : "Noted.";
  };
  return { users, reply };
}

// What a model reading its own context would do to continue: take the nextCursor of the newest session_read result in the given
// model input items, whether the result is whole (JSON) or was shortened for the context (the ORBIT cut note). undefined when that
// newest result has none (null at the edge, or lost).
export function findCursor(items: unknown[]): string | undefined {
  const all = items as { type?: string; name?: string; call_id?: string; output?: string }[];
  const call = [...all].reverse().find((i) => i.type === "function_call" && i.name === "session_read");
  const out = call && all.find((i) => i.type === "function_call_output" && i.call_id === call.call_id);
  if (!out?.output) return undefined;
  const hits = [...out.output.matchAll(/nextCursor"?:\s?"([A-Za-z0-9_-]{16,})"/g)];
  return hits.at(-1)?.[1];
}
