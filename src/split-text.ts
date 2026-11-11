// Long PR descriptions and review findings are never cut. GitHub accepts at most 65,536 characters in one body or comment, so a text
// longer than PART_CHARS is split into ordered parts that, joined again, are exactly the original (no gap, no repeat). Each part
// after the first is posted as its own comment with a marker, so a retry or a duplicate delivery can tell what is already there.

// Content per part. The wrapper around it (marker, part label, verdict header, notice) stays well under 5,000 characters.
export const PART_CHARS = 60_000;

export function splitText(text: string, limit = PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a paragraph break, then a line break, in the last half of the window; otherwise cut at the limit.
    let cut = window.lastIndexOf("\n\n");
    if (cut >= limit / 2) cut += 2;
    else {
      cut = window.lastIndexOf("\n");
      cut = cut >= limit / 2 ? cut + 1 : limit;
    }
    // Never split a surrogate pair.
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

export type PartKind = "pr" | "review";
export const partMarker = (job: string, kind: PartKind, k: number, n: number): string => `<!-- orbit-part job=${job} kind=${kind} part=${k}/${n} -->`;

// `<marker>\n**<label>**\n\n<chunk>`: the label is one line, so a reader (or a test) can take the chunk back out.
export const wrapPart = (marker: string, label: string, chunk: string): string => `${marker}\n**${label}**\n\n${chunk}`;
export const unwrapPart = (body: string): string => body.replace(/^<!-- orbit-part [^>\n]*-->\n\*\*[^\n]*\*\*\n\n/, "");
