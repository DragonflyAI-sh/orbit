// Tier 1 and tier 2 must stay byte-identical to the shipped ones whatever tier 3 does. Every file below is hashed (sha256 of its bytes)
// against the value on main at the start of the tier 3 follow-up (commit 8dcab1e). Changing any of them fails this test: such a change
// is a deliberate tier 1/2 change that needs its own review and its own pin update, never a side effect of a tier 3 change.
//
// Re-pinned for the host inventory (docs/host-inventory.md): helper.ts and protocol.ts gain one fixed action, `host_inventory`, that
// takes no arguments and answers only after a separate, root-owned activation (marker plus a module install.sh does not copy);
// docs/orbit-ops.md gains a pointer to it, and test/ops-admin.test.ts carries the same two new hashes. The seven existing actions,
// their parsing, bounds, redaction and audit are unchanged, and test/ops.test.ts still passes byte-identical.
//
// Re-pinned for partial config proposals (docs/orbit-ops-admin.md, "Partial changes"): a deliberate tier 2 change. admin-protocol.ts
// gains proposedConfigChanges, used only on ORBIT's side before a proposal exists (null or left out means unchanged; empty, blank,
// masked, unknown and no-change requests are refused); the helper's parseAdminRequest and validateConfigChanges are unchanged and
// still refuse nulls and empty values. ops-admin.ts uses it and its apply_config preview lists the unchanged settings and says a
// healthy /status is not a model check; docs/orbit-ops-admin.md documents both. admin-helper.ts, admin-run.ts, admin-core.ts, the
// client, units and installers are byte-identical.
//
// Re-pinned for the drill interrupt race: a deliberate tier 2 fix to deploy/pull-deploy.sh. A SIGINT that arrived while the drill's
// shell ran a foreground command could be dropped or run its trap in a broken parser state, so the drill neither restored nor
// exited 130. The drill's candidate phase now runs in a worker while the drill waits in `wait`, where a trapped signal is handled at
// once; the trap stops the worker before the same restore-and-verify recovery. Deploy, rollback and vault modes are unchanged.
//
// Re-pinned for platform instances (deploy/install-instance.sh): a deliberate tier 2 change to deploy/pull-deploy.sh. The service
// name, deploy root, env file and repo come from ORBIT_INSTANCE, ORBIT_DEPLOY_ROOT and ORBIT_DEPLOY_REPO, whose defaults are
// exactly the old literals (orbit, /opt/orbit, /opt/orbit/orbit.env, DragonflyAI-sh/orbit), so ORBIT's installed timer behaves
// as before; an invalid ORBIT_INSTANCE is refused (exit 64). Every mode's flow, lock, health check and rollback are unchanged.
//
// chat-tools.ts is shared with tier 3 (its tier 3 tools live in one block). That block is cut out (from "const sys = d.sys;" up to
// "const jobs = d.jobs;") and everything else must still be byte-identical: tier 1 and 2's tools cannot be touched from there.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const bytes = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const PINNED: [string, string][] = [
  ["src/ops/helper.ts", "0e1b9ea5499ea3626265d9b0ad75dd203096c695d9a6876e2e7dcc846522c714"],
  ["src/ops/protocol.ts", "a23d17f22fbe0f44499595358a7c00e6cd9dd9e14b7edfa9504d060e033ad1b5"],
  ["src/ops/admin-protocol.ts", "3663f168417354d2edae9b3c94f41a2eba235afc7abfca257360079357e4f00a"],
  ["src/ops/admin-core.ts", "4fbaa994ff3a5b71b404cdc5babcd1861017c3362c74a81fbf40b7a652537e46"],
  ["src/ops/admin-helper.ts", "28a6691caf6742e2eb7bc34551f123bcb2db2eb444d94e104f70d4fa442817e1"],
  ["src/ops/admin-run.ts", "e7e5358cacffed7fd214ef7a64caefaf4cfa862482711bc781fa7ad69dbcdc3d"],
  ["src/ops-client.ts", "e3a0190710bdf9648103810e8d9f9ca859e710bb8139830543dc08c747928d17"],
  ["src/ops-admin-client.ts", "e1ce686df6ccc744dcd1ac6c7caac21a25102952ae0e5a09f3d767cb004ff174"],
  ["src/ops-admin.ts", "45cca1b39e8fdc356828e4124833afd4bfb24d1740370939332d324cbc95d3e9"],
  ["deploy/systemd/orbit-ops@.service", "088be396050509047680bb157b625b19e11a6e25f0042e1753a4045765a86c63"],
  ["deploy/systemd/orbit-ops.socket", "9f2516a3337a99551b220d198c63b8b5dc100a0d0465fc6947d62add4d31c27e"],
  ["deploy/systemd/orbit.service", "1516761d0bda57cd699cf76e77108f079ac82185c267ea1920f3ab9b1b40d48e"],
  ["deploy/systemd/orbit-ops-admin-run@.service", "70c35796cac1c530f8a86f48a6d97e03719a7edb84ee9a03c74204fdc8e3c78c"],
  ["deploy/systemd/orbit-ops-admin-vault@.service", "2b362870ce5ccae21e965bbc44238703eccadf698dcb399a54181b57bce4a9cc"],
  ["deploy/systemd/orbit-ops-admin.socket", "c94eb2f675ed6d28afdc5e818fb7936f6a1976be7442306064412dbf9c6fb530"],
  ["deploy/systemd/orbit-ops-admin@.service", "d01a79f539ad6c3fdb65800aa040d059f999217c2081b32ca5c3f1f0b84623ee"],
  ["deploy/install.sh", "e4c013992ba3f2b43c5cb657a11f76483f2843c83d1532672afd4740e68e4d7e"],
  ["deploy/install-admin.sh", "241f27a20667e1cc941d3a9fdf27ff6203556c07bad2fbc7b25a37b42d6bb6a9"],
  ["deploy/pull-deploy.sh", "6bb9b46a82e9f6a4eb7862d04218be5da51adb19c1e36e4ace59889982aca588"],
  ["docs/orbit-ops.md", "4c8d67e513ed67d611d4d256212faff3c8f6e499902b1a694fe6a978ed259b0e"],
  ["docs/orbit-ops-admin.md", "1a968401fe064b7391cf68ef099464f51597a185e3d388836d5cd35c6bb59ac8"],
  ["test/ops.test.ts", "04005e1ca72fa5b4ac537aacedaaf0d648fee03942948757ee8caa89b1e4823f"],
  ["test/ops-admin.test.ts", "98b929f7d07ae5ba179ff73f6398773ce0a609bc130d22e3d1bb702a336a1110"],
  ["test/ops-admin-helper.test.ts", "43e27bd683c1f32deef878bafb86056bc39989757e8379d05b5921ae4afcff00"],
  ["test/pull-deploy-admin.test.ts", "5d6f58f962876c982464996141e597b0110678231429972266b7e2d7158cc0ff"],
];

test("tier 1 and tier 2 implementation, units, installers and docs are byte-identical to main at the start of the tier 3 follow-up", () => {
  assert.equal(PINNED.length, 25);
  for (const [file, hash] of PINNED) assert.equal(sha(bytes(file)), hash, `${file} changed: tier 1/2 must stay byte-identical`);
});

// Re-pinned for general tools part 1: memory_search/memory_read refresh the vault clone first, and the vault write tools and
// orbit_config_view are added after the memory tools. Nothing in the tier 1/2/3 tool blocks changed.
// Re-pinned for chat tool deadlines (docs/tool-deadlines.md): the read-only tools are marked `readOnly: true` and github_repo_status
// passes the call's abort signal to its requests. No tool's arguments, policy, proposal or confirmation path changed.
// Re-pinned for partial config proposals: ops_propose_config_change is a strict tool whose settings are each optional (nullable in the
// strict form), with a description and per-setting descriptions saying null or left out is unchanged, and its result lists the
// unchanged settings. Its proposal and confirmation path, policy and the other tools are unchanged.
test("shared integration: chat-tools.ts is identical to main outside the tier 3 block", () => {
  const lines = bytes("src/chat-tools.ts").toString("utf8").split("\n");
  const start = lines.indexOf("  const sys = d.sys;");
  const end = lines.indexOf("  const jobs = d.jobs;");
  assert.ok(start > 0 && end > start, "the tier 3 block is still delimited by the same two lines");
  assert.equal(sha(lines.slice(0, start).concat(lines.slice(end)).join("\n")), "6f739822556e52814877bcf282baf05af353a90ff4e9f0ad20613dc43552d4ba");
});

test("the tier 1/2 admin action list gained nothing, and tier 3 actions never appear in tier 1/2 code", () => {
  const admin = bytes("src/ops/admin-protocol.ts").toString("utf8");
  assert.match(admin, /MUTATING_ACTIONS = \["restart_orbit", "deploy_now", "rollback_release", "apply_config", "refresh_vault"\]/);
  for (const f of ["src/ops/helper.ts", "src/ops/protocol.ts", "src/ops/admin-protocol.ts", "src/ops/admin-core.ts", "src/ops/admin-helper.ts", "src/ops/admin-run.ts", "src/ops-client.ts", "src/ops-admin.ts", "src/ops-admin-client.ts"]) {
    assert.ok(!/reboot_host|install_os_updates|plan_os_updates|cancel_reboot|funnel_(en|dis)able/.test(bytes(f).toString("utf8")), f);
  }
});
