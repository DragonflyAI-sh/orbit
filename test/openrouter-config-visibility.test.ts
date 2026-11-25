import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configView } from "../src/config-view.ts";
import { OPENROUTER_CREDENTIAL, OPENROUTER_SETTINGS, openrouterConfig, openrouterStartupLog } from "../src/openrouter.ts";

// The OpenRouter fallback's configuration is visible without ever exposing the key: the config view shows the non-secret
// ORBIT_OPENROUTER_* settings and whether the orbit.openrouter credential is loaded; the startup log line says whether the fallback
// is off, armed or unusable and why.

// A fake key built at runtime (never a key-shaped literal in the source).
const fakeKey = () => ["or", "test", "x".repeat(24)].join("-");

const settings = {
  ORBIT_OPENROUTER_ENABLED: "1",
  ORBIT_OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
  ORBIT_OPENROUTER_PRICE_IN_USD_PER_MTOK: "0.25",
  ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK: "0.6",
  ORBIT_OPENROUTER_OUTPUT_BOUND_TOKENS: "1048576",
  ORBIT_OPENROUTER_DAILY_CAP_USD: "5",
  ORBIT_OPENROUTER_MONTHLY_CAP_USD: "150",
  ORBIT_OPENROUTER_TOTAL_CAP_USD: "off",
};

test("config view: the non-secret ORBIT_OPENROUTER_* settings are shown as running, and the credential is reported by name only", async () => {
  const creds = mkdtempSync(join(tmpdir(), "orbit-creds-"));
  const key = fakeKey();
  writeFileSync(join(creds, OPENROUTER_CREDENTIAL), key);
  const out = await configView({ env: { ...settings, CREDENTIALS_DIRECTORY: creds }, commit: "x", repoRoot: "/nonexistent" })([]);
  const v = out.value as any;
  assert.equal(v.env.value.ORBIT_OPENROUTER_MODEL, "deepseek/deepseek-v4-flash");
  assert.equal(v.env.value.ORBIT_OPENROUTER_ENABLED, "1");
  assert.equal(v.env.value.ORBIT_OPENROUTER_PRICE_OUT_USD_PER_MTOK, "0.6");
  assert.equal(v.env.value.ORBIT_OPENROUTER_TOTAL_CAP_USD, "off");
  assert.equal(v.env.value.ORBIT_OPENROUTER_SORT, "(not set)");
  for (const k of OPENROUTER_SETTINGS) assert.ok(k in v.env.value, k);
  assert.equal(v.credentials.loadedByThisProcess.value.openrouterFallbackCredential, "loaded in this process");
  assert.deepEqual(v.credentials.loadedByThisProcess.value.entries, [{ name: OPENROUTER_CREDENTIAL, sizeBytes: key.length, type: "file" }]);
  assert.ok(!JSON.stringify(out).includes(key), "the key itself never appears");
});

test("config view: a missing orbit.openrouter credential is said plainly, and an env key of any name is never shown", async () => {
  const creds = mkdtempSync(join(tmpdir(), "orbit-creds-"));
  const key = fakeKey();
  const out = await configView({ env: { ...settings, CREDENTIALS_DIRECTORY: creds, OPENROUTER_API_KEY: key }, commit: "x", repoRoot: "/nonexistent" })([]);
  const v = out.value as any;
  assert.match(v.credentials.loadedByThisProcess.value.openrouterFallbackCredential, /not loaded in this process \(orbit\.openrouter .*fallback cannot answer\)/);
  assert.ok(!("OPENROUTER_API_KEY" in v.env.value));
  assert.ok(!JSON.stringify(out).includes(key));
});

test("startup log: armed names the model and the loaded credential, never the key", () => {
  const key = fakeKey();
  const config = openrouterConfig({ ...settings, CREDENTIALS_DIRECTORY: "/creds" }, () => `${key}\n`);
  assert.equal(config.state, "ready");
  const line = openrouterStartupLog(config, new Date("2026-11-25T07:00:00Z"));
  assert.ok(!line.includes(key));
  assert.deepEqual(JSON.parse(line), { at: "2026-11-25T07:00:00.000Z", event: "openrouter_fallback_config", state: "ready", model: "deepseek/deepseek-v4-flash", credential: "orbit.openrouter loaded", sort: "throughput", allowFallbacks: true });
});

test("startup log: a missing credential, a missing model and a disabled fallback each say why", () => {
  const missing = (_dir: string): string => {
    throw new Error("ENOENT");
  };
  const noCred = JSON.parse(openrouterStartupLog(openrouterConfig({ ...settings, CREDENTIALS_DIRECTORY: "/creds" }, missing)));
  assert.equal(noCred.state, "unavailable");
  assert.match(noCred.reason, /orbit\.openrouter credential is not installed/);
  const noModel = JSON.parse(openrouterStartupLog(openrouterConfig({ ...settings, ORBIT_OPENROUTER_MODEL: "", CREDENTIALS_DIRECTORY: "/creds" }, fakeKey)));
  assert.equal(noModel.state, "unavailable");
  assert.match(noModel.reason, /ORBIT_OPENROUTER_MODEL is not set/);
  const off = JSON.parse(openrouterStartupLog(openrouterConfig({})));
  assert.equal(off.state, "disabled");
  assert.match(off.reason, /ORBIT_OPENROUTER_ENABLED/);
  assert.ok(!("model" in off) && !("credential" in off));
});
