import type { ChatTool } from "./agent.ts";

// Launch-time vault context export has been removed. ORBIT no longer reads vault notes at job launch, and never copies note text into
// orbit-work, a control branch, the brief or the fire text. A runner that needs vault context reads the exact notes its
// brief names from the Routine's own read-only vault checkout (tools/orbit-job/SKILL.md, "Vault context"; docs/job-context.md).
//
// What is left here only keeps an old-style request from being silently reinterpreted: a launch that still carries a `context` list (the
// chat tool's old argument, an old /jobs/launch body, a proposal made by an older build) is refused with a fixed, content-free reason, and
// nothing is registered, written or fired. Absent, `null` or `[]` meant "export nothing" before, and is still an ordinary launch.

export const LEGACY_CONTEXT_ERROR =
  "Vault context attachments are no longer supported: ORBIT does not read or copy vault notes at job launch. Nothing was launched. " +
  "To go ahead, launch again without `context` and name the exact vault notes in the brief instead; the runner reads them from its own read-only vault checkout and reports any it cannot find.";

// True when the input asks for the removed export: anything other than absent, null or an empty array.
export function hasLegacyContext(context: unknown): boolean {
  return !(context === undefined || context === null || (Array.isArray(context) && context.length === 0));
}

// Wraps the job_launch chat tool (chat-tools.ts is pinned by test/tier12-pin.test.ts) so that a call that still passes `context` fails in
// chat with no proposal, instead of quietly proposing a launch without the notes the model asked for. The schema does not offer `context`.
export function refuseLegacyContext(tools: ChatTool[]): ChatTool[] {
  return tools.map((t) =>
    t.name !== "job_launch"
      ? t
      : {
          ...t,
          run: async (a, ctx) => {
            const { context, ...rest } = a;
            if (hasLegacyContext(context)) throw new Error(LEGACY_CONTEXT_ERROR);
            return t.run(rest, ctx);
          },
        },
  );
}
