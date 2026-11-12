// Fabricated, never-real blocked cases for the corpus tool's per-rule recall check. Every value is assembled at run time from a seeded
// generator and split literals, so no secret-shaped literal exists in this file (the repository scans commits for them) and none of
// the values is usable anywhere. Each entry: the rule it should trigger and a text containing the value in ordinary surroundings.
let seed = 0x9e3779b1;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const random = (n: number, a = B62): string => Array.from({ length: n }, () => a[Math.floor(rnd() * a.length)]).join("");
const mixed = (n: number): string => "Q7" + random(n - 4) + "z9";

export type Fabricated = { rule: string; label: string; text: string };

export function fabricated(): Fabricated[] {
  const f: Fabricated[] = [];
  const add = (rule: string, label: string, value: string) => {
    for (const [wrap, text] of [["plain", value], ["prose", `Notes: the value is ${value}, kept for later.`], ["crlf", `# T\r\n${value}\r\nnext\r\n`]] as const) f.push({ rule, label: `${label} (${wrap})`, text });
  };
  for (const [label, value] of [
    ["openai-style", "s" + "k-" + random(40)],
    ["anthropic-style", "s" + "k-ant-" + random(40)],
    ["stripe-style", "s" + "k_live_" + random(24)],
    ["github", "gh" + "p_" + random(36)],
    ["github fine-grained", "github" + "_pat_" + random(40)],
    ["gitlab", "gl" + "pat-" + random(20)],
    ["tailscale", "ts" + "key-auth-" + random(24)],
    ["slack", "xox" + "b-" + random(30, "0123456789")],
    ["aws", "AK" + "IA" + random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")],
    ["google", "AI" + "za" + random(35)],
    ["npm", "np" + "m_" + random(36)],
  ] as const) add("secret.provider-token", label, value);
  add("secret.jwt", "jwt", "ey" + "J" + random(20) + "." + random(24) + "." + random(24));
  add("secret.private-key", "pem", "-----BEGIN " + "PRIVATE KEY-----\n" + random(64) + "\n" + random(64) + "\n-----END " + "PRIVATE KEY-----");
  add("secret.private-key", "pem without end", "-----BEGIN " + "RSA PRIVATE KEY-----\n" + random(64));
  add("secret.bearer-token", "bearer", "Bear" + "er " + mixed(30));
  add("secret.bearer-token", "basic", "Bas" + "ic " + btoa("user:" + random(12)));
  add("secret.url-credentials", "url password", "https://user:" + mixed(14) + "@example.com/x.git");
  add("secret.routine-trigger", "trigger id", "tri" + "g_" + random(20));
  for (const [label, value] of [
    ["password", "pass" + "word: " + "Hunter2" + "hunter2"],
    ["password quoted", "pass" + 'word = "' + mixed(16) + '"'],
    ["api key", "api_" + "key=" + mixed(24)],
    ["client secret", "client_" + "secret = '" + mixed(20) + "'"],
    ["env password", "DB_PASS" + "WORD=" + mixed(16)],
    ["bold credential", "**Credential:** " + mixed(32)],
    ["token", "to" + "ken: " + mixed(26)],
  ] as const) add("secret.credential-assignment", label, value);
  return f;
}

// Texts that must NOT be flagged (ordinary vault text), as a precision counterpart.
export function ordinary(): { label: string; text: string }[] {
  const long = "orbit-next-secret-detector-false-positives";
  return [
    { label: "heading", text: "## Credential:\n# Token:\n**Credential:** stored in the keychain\n" },
    { label: "long names", text: `[[${long}]] Tasks/${long}.md /home/user/vault/Projects/${long}.md\n` },
    { label: "identifiers", text: `commit 0123456789abcdef0123456789abcdef01234567 id ${random(36)} digest ${random(64, "0123456789abcdef")}\n` },
    { label: "service health", text: "service health: diagnostics failing; symptoms: timeouts; token refresh failing; password rotation overdue\n" },
    { label: "verdicts", text: "PASS: all 770 tests; passed: 12 of 12; tokens: 4096; token: 2026-11-12\n" },
  ];
}
