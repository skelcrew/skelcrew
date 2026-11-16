// Reading when a harness's usage limit resets, from the words its error gives, such as Codex's
// "try again at 1:59 PM" or Claude Code's "resets 2pm".

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// A clock time, with the day before it when the reset isn't today: "1:59 PM", "2pm",
// "Nov 17th, 2026 1:59 PM" or "Nov 17, 2pm".
const clock = new RegExp(
  `(?:\\b(${months.join("|")})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (?:(\\d{4}),? )?)?(\\d{1,2})(?::(\\d{2}))? ?([ap])\\.?m\\b`,
  "i",
);

// Returns the moment, in milliseconds since 1970, that the clock time in `text` names, or null
// when it names none. It is read in this machine's time zone, as the harness runs here too and
// writes its times in it. A time with no day is the next time the clock shows it, so a reset
// at 1:59 AM read at 11 PM is tomorrow's. The clock shows only minutes, so a time within the
// minute just gone is still today's: the limit may reset any second.
export function resetTime(text: string, now: number): number | null {
  // Read the parts of the time, and give up on any that can't be one.
  const found = clock.exec(text);
  if (!found) return null;
  const [, month, day, year, hour, minute = "0", half = "a"] = found;
  const hours = (Number(hour) % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  if (Number(hour) > 12 || Number(minute) > 59) return null;
  // A day named with it is that day. Without a year, it is the next such day from now.
  const at = new Date(now);
  at.setHours(hours, Number(minute), 0, 0);
  if (month !== undefined && day !== undefined) {
    const index = months.indexOf(month.toLowerCase());
    at.setFullYear(year === undefined ? at.getFullYear() : Number(year), index, Number(day));
    if (year === undefined && at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  if (at.getTime() + 60_000 <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}
