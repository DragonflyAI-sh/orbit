import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { smallJpeg, withMetadata } from "./jpeg-fixture.ts";

// Photos survive a real process restart (docs/photos.md): a separate ORBIT server process (test/helpers/photo-server.ts) stores photos
// in a temporary state directory and is killed with SIGKILL; a new process over the same directory serves the same bytes and shows
// the same message references, in chat threads and the Assistant.

/* eslint-disable @typescript-eslint/no-explicit-any */
const HELPER = new URL("./helpers/photo-server.ts", import.meta.url).pathname;
const running = new Set<ChildProcess>();
after(() => {
  for (const p of running) p.kill("SIGKILL");
});

function start(dir: string): Promise<{ base: string; proc: ChildProcess }> {
  const proc = spawn(process.execPath, [HELPER, dir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STATE_DIRECTORY: "" } });
  running.add(proc);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    proc.stderr!.on("data", (d) => (err += d));
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/PORT (\d+)/);
      if (m) resolve({ base: `http://127.0.0.1:${m[1]}`, proc });
    });
    proc.on("exit", (code) => reject(new Error(`helper exited ${code}: ${err.slice(0, 2000)}`)));
  });
}
const stop = (proc: ChildProcess) => new Promise<void>((res) => {
  proc.once("exit", () => res());
  proc.kill("SIGKILL");
  running.delete(proc);
});
const json = async (base: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any };
};
const upload = async (base: string, path: string, bytes: Buffer) => (await (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(bytes) })).json() as any).attachment.id as string;
const bytesAt = async (base: string, path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
};

test("photos, their message references and their bytes survive SIGKILL and a new process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-photo-restart-"));
  const first = await start(dir);
  const thread = (await json(first.base, "/threads", {})).data.thread;
  const chatIds = [await upload(first.base, `/threads/${thread.id}/attachments`, withMetadata(smallJpeg(1))), await upload(first.base, `/threads/${thread.id}/attachments`, smallJpeg(2))];
  const sent = await json(first.base, `/threads/${thread.id}/messages`, { text: "two photos", attachments: chatIds });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.thread.messages[1].text, "saw 2 photo(s)");
  const aid = await upload(first.base, "/assistant/attachments", smallJpeg(3));
  const asent = await json(first.base, "/assistant/messages", { text: "one photo", attachments: [aid], requestId: "restart-req-0001" });
  assert.equal(asent.status, 200, JSON.stringify(asent.data));
  // An upload that was never sent: still pending after the restart, sendable then.
  const pendingId = await upload(first.base, "/assistant/attachments", smallJpeg(4));
  const before = await Promise.all([...chatIds.map((id) => bytesAt(first.base, `/threads/${thread.id}/attachments/${id}`)), bytesAt(first.base, `/assistant/attachments/${aid}`)]);
  await stop(first.proc);

  const second = await start(dir);
  const view = (await json(second.base, `/threads/${thread.id}`)).data.thread;
  assert.deepEqual(view.messages[0].attachments.map((a: any) => a.id), chatIds);
  const after = await Promise.all([...chatIds.map((id) => bytesAt(second.base, `/threads/${thread.id}/attachments/${id}`)), bytesAt(second.base, `/assistant/attachments/${aid}`)]);
  for (const [i, a] of after.entries()) {
    assert.equal(a.status, 200);
    assert.ok(a.bytes.equals(before[i]!.bytes), "the same processed bytes");
  }
  const av = (await json(second.base, "/assistant")).data.assistant;
  assert.equal(av.chunks.at(-1).messages[0].attachments[0].id, aid);
  // Bound photos still cannot be reused after the restart; the pending one can be sent.
  assert.equal((await json(second.base, `/threads/${thread.id}/messages`, { text: "reuse", attachments: [chatIds[0]] })).status, 409);
  const later = await json(second.base, "/assistant/messages", { text: "the leftover", attachments: [pendingId], requestId: "restart-req-0002" });
  assert.equal(later.status, 200);
  assert.equal(later.data.assistant.chunks.at(-1).messages[1].text, "saw 1 photo(s)");
  await stop(second.proc);
});
