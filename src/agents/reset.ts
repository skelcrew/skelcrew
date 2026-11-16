// Reading when a harness's usage limit resets, from the words its error gives, such as Codex's
// "try again at 1:59 PM" or Claude Code's "resets 2pm (Europe/London)".

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// A clock time, with the day before it when the reset isn't today: "1:59 PM", "2pm",
// "Nov 17th, 2026 1:59 PM" or "Nov 17, 2pm".
const clock = new RegExp(
  `(?:\\b(${months.join("|")})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (?:(\\d{4}),? )?)?(\\d{1,2})(?::(\\d{2}))? ?([ap])\\.?m\\b`,
  "i",
);
// The time zone Claude Code names after the time, such as "(Europe/London)" or "(UTC)".
const named = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)/;

// Returns the date and time a clock in `zone` shows at the moment `at`.
function clockIn(zone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month") - 1,
    day: part("day"),
    hours: part("hour"),
    minutes: part("minute"),
    seconds: part("second"),
  };
}

// Returns the moment a clock in `zone` shows this date and time. A day past the month's end
// rolls into the next month, as Date does. It starts from the time as if in UTC and corrects
// by the zone's offset, twice, so a change of offset near the moment is followed too.
function momentIn(
  zone: string,
  date: { year: number; month: number; day: number },
  hours: number,
  minutes: number,
): number {
  const wanted = Date.UTC(date.year, date.month, date.day, hours, minutes);
  let at = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const shown = clockIn(zone, at);
    at +=
      wanted -
      Date.UTC(shown.year, shown.month, shown.day, shown.hours, shown.minutes, shown.seconds);
  }
  return at;
}

// Returns the zone named in `text`, or null when there is none or this machine doesn't know it.
function zoneOf(text: string): string | null {
  const zone = named.exec(text)?.[1];
  if (zone === undefined) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

// Returns the moment, in milliseconds since 1970, that the clock time in `text` names, or null
// when it names none. It is read in the time zone named after it, such as "(Europe/London)",
// or else in this machine's, as the harness runs here too and writes its times in it. A time
// with no day is the next time the clock shows it, so a reset at 1:59 AM read at 11 PM is
// tomorrow's. The clock shows only minutes, so a time within the minute just gone is still
// today's: the limit may reset any second.
export function resetTime(text: string, now: number): number | null {
  // Read the parts of the time, and give up on any that can't be one.
  const found = clock.exec(text);
  if (!found) return null;
  const [, month, day, year, hour, minute = "0", half = "a"] = found;
  if (Number(hour) > 12 || Number(minute) > 59) return null;
  const hours = (Number(hour) % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  const zone = zoneOf(text) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = clockIn(zone, now);
  // The first of the given days whose time hasn't gone, allowing the minute just gone.
  const first = (dates: { year: number; month: number; day: number }[]) => {
    const moments = dates.map((date) => momentIn(zone, date, hours, Number(minute)));
    return moments.find((at) => at + 60_000 > now) ?? moments[moments.length - 1] ?? null;
  };
  // A day named with it is that day. Without a year, it is the next such day from now.
  if (month !== undefined && day !== undefined) {
    const date = { month: months.indexOf(month.toLowerCase()), day: Number(day) };
    if (year !== undefined) return first([{ ...date, year: Number(year) }]);
    return first([
      { ...date, year: today.year },
      { ...date, year: today.year + 1 },
    ]);
  }
  return first([today, { ...today, day: today.day + 1 }]);
}
