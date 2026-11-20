// Reads the JUnit report of a test run and the time of each file, and says where its time went:
// the slowest tests and the slowest files. CI prints it, as the tests that start a real sandbox run only there.
import { z } from "zod";

// What a test case in Bun's report says. A file whose worker was stopped or crashed has one
// case in its place, named "(worker crashed)", with no time and its file as its classname.
const testCase = z.object({
  name: z.string(),
  classname: z.string().default(""),
  file: z.string().optional(),
  time: z.coerce.number().default(0),
});

// How long a whole test file took, as scripts/file-times.ts writes it, one to a line.
const fileTime = z.object({ file: z.string(), seconds: z.number() });

// Undoes the XML escapes Bun writes in an attribute.
const fromXml = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

// Returns the `count` slowest tests, then each file's time, slowest first, as lines for a log,
// and last the files' times as one line of JSON, for test/times.json.
// `report` is Bun's JUnit report and `files` the lines of each file's time. A file cut off
// before it reported, such as one still running when the run was stopped, has no time, so it
// says so, first, as it is likely the slowest.
export function timings(report: string, files: string, count: number): string {
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

  // Each file's whole time, read line by line and checked.
  const fileTimes = files
    .split("\n")
    .filter(Boolean)
    .map((line) => fileTime.parse(JSON.parse(line)))
    .toSorted((a, b) => b.seconds - a.seconds);
  const perFile = [
    ...cutOff.map((file) => `${"cut off".padStart(9)}  ${file}`),
    ...fileTimes.map((one) => `${seconds(one.seconds)}  ${one.file}`),
  ];
  // The same times as test/times.json keeps them, which CI's shards are split by. Each shard
  // prints its own files, so the four lines together make the file.
  const asJson = JSON.stringify(
    Object.fromEntries(fileTimes.map((one) => [one.file, Math.round(one.seconds * 10) / 10])),
  );
  return [
    "The slowest tests:",
    ...slowest,
    "",
    "Time per file:",
    ...perFile,
    "",
    "For test/times.json:",
    asJson,
    "",
  ].join("\n");
}
