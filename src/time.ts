export const ZONE = "America/Los_Angeles";
const QUIET_START = 23;
const QUIET_END = 8;

function parts(date: Date, zone: string) {
  const out = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

// The UTC instant for a wall-clock time in a zone; correct across daylight-saving changes.
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone = ZONE): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (at: number) => {
    const p = parts(new Date(at), zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

// The next time after `after` that the zone's clock reads hh:mm.
export function nextDaily(hhmm: string, after: Date, zone = ZONE): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  const today = parts(after, zone);
  for (let add = 0; add < 3; add++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, zone);
    if (at > after) return at;
  }
  throw new Error(`no next time for ${hhmm}`);
}

// Quiet hours are 23:00-08:00 Pacific. Returns when a non-urgent message may go out.
export function quietUntil(at: Date, zone = ZONE): Date | undefined {
  const hour = parts(at, zone).hour;
  if (hour >= QUIET_START || hour < QUIET_END) return nextDaily(`${String(QUIET_END).padStart(2, "0")}:00`, at, zone);
  return undefined;
}

export function isDailyTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
