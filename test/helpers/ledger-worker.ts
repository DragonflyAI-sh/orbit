// A child process that uses the spend ledger, for tests that need real competing processes. Run by test/spend-ledger-multiprocess.test.ts:
//   node test/helpers/ledger-worker.ts '<json spec>'
// It prints one JSON object per line: {"ready":true}, then one result per operation. It waits for `go` (a file) so the workers start
// together, and can be told to kill itself or hang at a named point inside the ledger's critical section (deterministic fault injection).
import { existsSync } from "node:fs";
import { spendLedger } from "../../src/spend-ledger.ts";
import type { SpendCaps } from "../../src/spend-ledger.ts";

type Spec = {
  dir: string;
  caps: SpendCaps;
  go: string;
  lockWaitMs?: number;
  ops: ({ op: "reserve"; micro: number; count?: number; settle?: number | null } | { op: "die" } | { op: "view" })[];
  // kill: SIGKILL this process there. throw: raise an error there. hold: stay there for `ms` (a live process holding the lock).
  fault?: { point: string; action: "kill" | "throw" | "hold"; ms?: number; nth?: number };
  identity?: { host?: string; pid?: number; start?: string };
};
const spec = JSON.parse(process.argv[2]!) as Spec;
const out = (o: unknown) => void process.stdout.write(`${JSON.stringify(o)}\n`);
const sleepMs = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let armed = false;
let hits = 0;
const fault = (point: string) => {
  const f = spec.fault;
  if (!armed || !f || f.point !== point || ++hits !== (f.nth ?? 1)) return;
  if (f.action === "kill") process.kill(process.pid, "SIGKILL");
  else if (f.action === "throw") throw new Error("injected fault");
  else {
    out({ holding: point });
    sleepMs(f.ms ?? 1000);
  }
};

const ledger = spendLedger(spec.dir, spec.caps, () => new Date("2026-11-12T10:00:00Z"), { lockWaitMs: spec.lockWaitMs ?? 20_000, fault, identity: spec.identity });
out({ ready: true });
while (!existsSync(spec.go)) sleepMs(1);
armed = true;
for (const o of spec.ops) {
  if (o.op === "die") process.kill(process.pid, "SIGKILL");
  else if (o.op === "view") out({ view: ledger.view() });
  else {
    for (let i = 0; i < (o.count ?? 1); i++) {
      try {
        const r = ledger.reserve(o.micro);
        out({ ok: true, id: r.id });
        if (o.settle !== undefined) ledger.settle(r.id, o.settle === null ? undefined : o.settle);
      } catch (err) {
        out({ err: (err as { code?: string }).code ?? "other", msg: (err as Error).message });
      }
    }
  }
}
out({ done: true });
