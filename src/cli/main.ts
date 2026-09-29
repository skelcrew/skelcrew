#!/usr/bin/env bun
// The `skelcrew` program: runs one command and prints what it says.
// Refusals go to standard error, with exit code 1.

import { run } from "./cli";
import { startDaemon } from "./start";

const outcome = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  session: process.env.SKELCREW_SESSION,
  // A spec typed at the terminal isn't expected, so a terminal gives none.
  readStdin: async () => (process.stdin.isTTY ? "" : await Bun.stdin.text()),
  start: startDaemon,
  announce: (line) => console.log(line),
});
for (const line of outcome.out) console.log(line);
for (const line of outcome.err) console.error(line);
process.exit(outcome.code);
