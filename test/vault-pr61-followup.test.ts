import assert from "node:assert/strict";
import { test } from "node:test";
import { sensitiveCategories } from "../src/vault/edit.ts";

// Health-screen follow-ups from the PR #61 review (the credential-assignment follow-ups moved to vault-filter.test.ts when the
// credential rules were reduced to known shapes). Everything is synthetic.

// ---- Secondary: health screen --------------------------------------------------------------------------------------------------------

test("health: named disclosures involving Crohn's (both apostrophes), lupus, MS, chemo, rehab ask for confirmation", () => {
  for (const t of [
    "Pat has Crohn's disease.", "Pat has Crohn’s disease.", "Sam has Crohns.", "Lee was diagnosed with lupus.", "Lee has lupus.",
    "Kim has multiple sclerosis.", "Kim was diagnosed with MS.", "Kim has MS.", "Ana started chemo last week.", "Ana had chemotherapy.", "Jo is in rehab.",
  ]) assert.deepEqual(sensitiveCategories(t, ""), ["health"], t);
  // already present in the note: not new
  assert.deepEqual(sensitiveCategories("Pat has Crohn's disease.", "Pat has Crohn's disease."), []);
});

test("health: technical prose with MS as milliseconds, MS Office or MS SQL is not matched", () => {
  for (const t of ["The request took 20 ms and the retry took 3 MS.", "MS Office build failed on the CI host.", "MS SQL server latency is 40 ms.", "Use ms resolution in the metrics.", "The scheduler stalled for 5 ms."])
    assert.deepEqual(sensitiveCategories(t, ""), [], t);
});

test("health: finite coverage is stated: unlisted conditions and bare acronyms are not caught; routing still goes through confirmation", () => {
  assert.deepEqual(sensitiveCategories("Pat has fibromyalgia.", ""), []);
  assert.deepEqual(sensitiveCategories("Pat has MS and sees a doctor.", ""), ["health"]);
});
