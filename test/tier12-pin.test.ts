// Tier 1 and tier 2 must stay byte-identical to the shipped ones whatever tier 3 does. Every file below is hashed (sha256 of its bytes)
// against the value on main at the start of the tier 3 follow-up (commit 8dcab1e). Changing any of them fails this test: such a change
// is a deliberate tier 1/2 change that needs its own review and its own pin update, never a side effect of a tier 3 change.
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
  ["src/ops/helper.ts", "47e6384d82720177166f876ce9dd5bc7d56a9efa3ba01b208c6b96a8078fad5a"],
  ["src/ops/protocol.ts", "3a1dea9c7c865639387531b173c5f6e93d3ba346f789a1b482db2d7cb338b1f1"],
  ["src/ops/admin-protocol.ts", "60fd390d9feba492ea131f8243644445de2b7fafadc21e2596ccb7e35e58ae1b"],
  ["src/ops/admin-core.ts", "4fbaa994ff3a5b71b404cdc5babcd1861017c3362c74a81fbf40b7a652537e46"],
  ["src/ops/admin-helper.ts", "28a6691caf6742e2eb7bc34551f123bcb2db2eb444d94e104f70d4fa442817e1"],
  ["src/ops/admin-run.ts", "e7e5358cacffed7fd214ef7a64caefaf4cfa862482711bc781fa7ad69dbcdc3d"],
  ["src/ops-client.ts", "e3a0190710bdf9648103810e8d9f9ca859e710bb8139830543dc08c747928d17"],
  ["src/ops-admin-client.ts", "e1ce686df6ccc744dcd1ac6c7caac21a25102952ae0e5a09f3d767cb004ff174"],
  ["src/ops-admin.ts", "6350c26c207570e14e1af22040d15f4f62abfb03a149a42100bed2c5f9b1f5f6"],
  ["deploy/systemd/orbit-ops@.service", "088be396050509047680bb157b625b19e11a6e25f0042e1753a4045765a86c63"],
  ["deploy/systemd/orbit-ops.socket", "9f2516a3337a99551b220d198c63b8b5dc100a0d0465fc6947d62add4d31c27e"],
  ["deploy/systemd/orbit.service", "1516761d0bda57cd699cf76e77108f079ac82185c267ea1920f3ab9b1b40d48e"],
  ["deploy/systemd/orbit-ops-admin-run@.service", "70c35796cac1c530f8a86f48a6d97e03719a7edb84ee9a03c74204fdc8e3c78c"],
  ["deploy/systemd/orbit-ops-admin-vault@.service", "2b362870ce5ccae21e965bbc44238703eccadf698dcb399a54181b57bce4a9cc"],
  ["deploy/systemd/orbit-ops-admin.socket", "c94eb2f675ed6d28afdc5e818fb7936f6a1976be7442306064412dbf9c6fb530"],
  ["deploy/systemd/orbit-ops-admin@.service", "d01a79f539ad6c3fdb65800aa040d059f999217c2081b32ca5c3f1f0b84623ee"],
  ["deploy/install.sh", "e4c013992ba3f2b43c5cb657a11f76483f2843c83d1532672afd4740e68e4d7e"],
  ["deploy/install-admin.sh", "241f27a20667e1cc941d3a9fdf27ff6203556c07bad2fbc7b25a37b42d6bb6a9"],
  ["deploy/pull-deploy.sh", "4060cfbb675d1c682c9240270771e98c18194d0cc02d653e2bc3579a7e136ac4"],
  ["docs/orbit-ops.md", "46fbfafdc9067ce5de723095c9a6d3b02f1e766c9b5c13ad3c8b7054f956578f"],
  ["docs/orbit-ops-admin.md", "cd175ab463a5b4f26b24ca75996f237acea072a9eabf07b96b40e57c037ccf66"],
  ["test/ops.test.ts", "04005e1ca72fa5b4ac537aacedaaf0d648fee03942948757ee8caa89b1e4823f"],
  ["test/ops-admin.test.ts", "60bd30daa6bcfc04a06ad1435299b8b2457a2ae61ad5ec180785a813111599e8"],
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
test("shared integration: chat-tools.ts is identical to main outside the tier 3 block", () => {
  const lines = bytes("src/chat-tools.ts").toString("utf8").split("\n");
  const start = lines.indexOf("  const sys = d.sys;");
  const end = lines.indexOf("  const jobs = d.jobs;");
  assert.ok(start > 0 && end > start, "the tier 3 block is still delimited by the same two lines");
  assert.equal(sha(lines.slice(0, start).concat(lines.slice(end)).join("\n")), "30d5f41930f0ce2d4cb7e99b14cc0cd208e5b316c763e3024579808a6f346c2f");
});

test("the tier 1/2 admin action list gained nothing, and tier 3 actions never appear in tier 1/2 code", () => {
  const admin = bytes("src/ops/admin-protocol.ts").toString("utf8");
  assert.match(admin, /MUTATING_ACTIONS = \["restart_orbit", "deploy_now", "rollback_release", "apply_config", "refresh_vault"\]/);
  for (const f of ["src/ops/helper.ts", "src/ops/protocol.ts", "src/ops/admin-protocol.ts", "src/ops/admin-core.ts", "src/ops/admin-helper.ts", "src/ops/admin-run.ts", "src/ops-client.ts", "src/ops-admin.ts", "src/ops-admin-client.ts"]) {
    assert.ok(!/reboot_host|install_os_updates|plan_os_updates|cancel_reboot|funnel_(en|dis)able/.test(bytes(f).toString("utf8")), f);
  }
});
