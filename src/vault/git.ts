import { spawn } from "node:child_process";

// Runs git for the vault clone. Three rules:
//  - no shell: arguments are an array, and anything that is data (paths, messages) goes after `--` or on stdin;
//  - the GitHub credential reaches git only through the environment of the child process, as a one-request HTTP header
//    (GIT_CONFIG_COUNT/KEY/VALUE), scoped to https://github.com/. It is never in a URL, a command line, a file or the
//    clone's .git/config, and git is told to ignore every other config file and hook;
//  - everything git prints is scrubbed of the credential before ORBIT sees it, logs it or returns it.

export type GitResult = { code: number; stdout: string; stderr: string };
export type GitRunner = {
  run(args: string[], opts?: { cwd?: string; input?: string; allowFail?: boolean; timeoutMs?: number }): Promise<GitResult>;
  // Removes the credential (and its encodings) from any text.
  scrub(text: string): string;
};

export const GIT_AUTHOR = { name: "ORBIT", email: "orbit@users.noreply.github.com" };
const TIMEOUT_MS = 60_000;
const MAX_OUT = 256 * 1024;

export function gitRunner(opts: { token?: string; allowProtocols: string; author?: { name: string; email: string } }): GitRunner {
  const token = opts.token;
  const author = opts.author ?? GIT_AUTHOR;
  const basic = token ? Buffer.from(`x-access-token:${token}`).toString("base64") : undefined;
  const secrets = [token, basic, token ? encodeURIComponent(token) : undefined].filter((s): s is string => Boolean(s) && String(s).length >= 4);

  const scrub = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join("[credential]");
    // A credential in any URL userinfo or header that git echoes.
    return out.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[credential]@").replace(/(authorization:\s*\w+\s+)\S+/gi, "$1[credential]");
  };

  const config: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["credential.helper", ""],
    ["gc.auto", "0"],
    ["protocol.version", "2"],
    ...(basic ? ([["http.https://github.com/.extraHeader", `Authorization: Basic ${basic}`]] as [string, string][]) : []),
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    HOME: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: opts.allowProtocols,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };

  return {
    scrub,
    run: (args, o = {}) =>
      new Promise<GitResult>((resolve, reject) => {
        const child = spawn("git", args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], timeout: o.timeoutMs ?? TIMEOUT_MS, killSignal: "SIGKILL" });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => void (stdout = (stdout + c).slice(-MAX_OUT)));
        child.stderr.on("data", (c: Buffer) => void (stderr = (stderr + c).slice(-MAX_OUT)));
        child.on("error", (err) => reject(new Error(scrub(`git could not run: ${err.message}`))));
        child.on("close", (code, signal) => {
          const result = { code: code ?? (signal ? 137 : 1), stdout: scrub(stdout), stderr: scrub(stderr) };
          if (result.code !== 0 && !o.allowFail) reject(new Error(`git ${args[0]} failed (${signal ?? result.code}): ${result.stderr.trim().slice(0, 300) || result.stdout.trim().slice(0, 300)}`));
          else resolve(result);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(o.input ?? "");
      }),
  };
}
