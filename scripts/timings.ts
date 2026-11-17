// Reads the JUnit report of a test run and says where its time went: the slowest tests and the
// time of each file. CI prints it, as the tests that start a real sandbox run only there.
import { z } from "zod";

// What a test case in Bun's report says. A file whose worker was stopped or crashed has one
// case in its place, named "(worker crashed)", with no time and its file as its classname.
const testCase = z.object({
  name: z.string(),
  classname: z.string().default(""),
  file: z.string().optional(),
  time: z.coerce.number().default(0),
});

// Undoes the XML escapes Bun writes in an attribute.
const fromXml = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

// Returns the `count` slowest tests, then each file's time, slowest first, as lines for a log.
// A file's time is what its tests took. A file cut off before it reported, such as one still
// running when the run was stopped, has no times, so it says so, first, as it is likely the
// slowest.
export function timings(report: string, count: number): string {
  // Each test case's attributes, read as text and checked.
  const cases = [...report.matchAll(/<testcase\s([^>]*?)\s*\/?>/g)].map((match) =>
    testCase.parse(
      Object.fromEntries(
        [...(match[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [
          key,
          fromXml(value ?? ""),
        ]),
      ),
    ),
  );
  const cutOff = cases.filter((one) => one.name === "(worker crashed)").map((one) => one.classname);
  const ran = cases.filter((one) => one.name !== "(worker crashed)");
  const seconds = (time: number) => `${time.toFixed(1)} s`.padStart(9);

  // A test in a describe block is named with it, as Bun escapes the block's name twice.
  const slowest = ran
    .toSorted((a, b) => b.time - a.time)
    .slice(0, count)
    .map((one) => {
      const group = fromXml(one.classname);
      const name = group ? `${group} > ${one.name}` : one.name;
      return `${seconds(one.time)}  ${one.file ?? ""}  ${name}`;
    });

  // Adds up each file's tests.
  const files = new Map<string, number>();
  for (const one of ran) files.set(one.file ?? "", (files.get(one.file ?? "") ?? 0) + one.time);
  const perFile = [
    ...cutOff.map((file) => `${"cut off".padStart(9)}  ${file}`),
    ...[...files]
      .toSorted(([, a], [, b]) => b - a)
      .map(([file, time]) => `${seconds(time)}  ${file}`),
  ];
  return ["The slowest tests:", ...slowest, "", "Time per file:", ...perFile, ""].join("\n");
}
