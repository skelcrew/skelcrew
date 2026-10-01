#!/usr/bin/env bun
// The `skelcrew` program: runs one command and prints what it says.
// Refusals go to standard error, with exit code 1.

import { findRepo, run } from "./cli";
import { startDaemon } from "./start";

const args = process.argv.slice(2);

// Bare `skelcrew` in a terminal opens the TUI. Ink is imported only here,
// so every other command stays fast. Outside a repository, `run` says so.
if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const repo = findRepo(process.cwd());
  if (repo !== null) {
    const { open } = await import("../tui/open");
    await open(repo);
    process.exit(0);
  }
}

const outcome = await run(args, {
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
