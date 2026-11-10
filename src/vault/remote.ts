// Remote URLs can carry credentials (https://user:secret@host/..., ssh://git@host/..., git@host:path). ORBIT never needs them
// there (the credential is a systemd credential, sent as a header), but a configured value must not leak if someone does put
// them in: not in the config view, not in an error, not in a log line. Only the host and path are ever shown.

const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s;
const SCP_LIKE = /^([^/@\s:]+)@([^:/\s]+):(.*)$/s;
const IN_TEXT = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#'"<>]*@/g;

export const REDACTED_USERINFO = "[redacted]";

// True when the URL carries a user name or password (anything before an @ in the authority, or scp-style user@host:path).
export function hasUserinfo(url: string): boolean {
  const m = SCHEME_URL.exec(url);
  if (m) return m[2]!.includes("@");
  return SCP_LIKE.test(url) || url.includes("@");
}

// The remote as it may be shown: userinfo replaced by [redacted]. When the value cannot be parsed but holds an @, nothing of it is shown.
export function maskRemote(url: string): string {
  const m = SCHEME_URL.exec(url);
  if (m) {
    const at = m[2]!.lastIndexOf("@");
    return at < 0 ? url : `${m[1]}${REDACTED_USERINFO}@${m[2]!.slice(at + 1)}${m[3]}`;
  }
  const s = SCP_LIKE.exec(url);
  if (s) return `${REDACTED_USERINFO}@${s[2]}:${s[3]}`;
  return url.includes("@") ? `[remote not shown: it contains userinfo]` : url;
}

// Any URL userinfo inside free text (git and network errors echo the URL they were given).
export function scrubUserinfo(text: string): string {
  return text.replace(IN_TEXT, `$1${REDACTED_USERINFO}@`);
}
