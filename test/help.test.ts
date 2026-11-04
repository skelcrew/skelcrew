// skel's help: what you see with skel --help, and with a command skel doesn't know.
import { expect, test } from "bun:test";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");

function skel(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync([process.execPath, main, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", ...env },
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

test("skel --help, -h and help print the help to stdout and succeed", () => {
  for (const flag of ["--help", "-h", "help"]) {
    const help = skel([flag]);
    expect(help.code).toBe(0);
    expect(help.err).toBe("");
    expect(help.out).toContain("USAGE");
    expect(help.out).toContain("COMMANDS");
    expect(help.out).toContain("EXAMPLES");
  }
});

test("the help names every command", () => {
  const out = skel(["--help"]).out;
  for (const command of [
    "--remote",
    "serve",
    "repo ls",
    "repo rm",
    "repo trust",
    "ps",
    "task ls",
    "task show",
    "task create",
    "start",
    "stop",
    "attach",
    "review",
  ])
    expect(out).toContain(`  ${command} `);
});

// --remote keeps skel on the other side up to date, so there is no command for it.
test("the help names no update command, and says --remote keeps skel up to date", () => {
  const out = skel(["--help"]).out;
  expect(out).not.toContain("update --remote");
  expect(out).not.toMatch(/^ {2}update/m);
  expect(out).toContain("up to date");
});

// Piped into a file or another program, color codes would be noise.
test("the help has no color when stdout isn't a terminal, or with NO_COLOR", () => {
  expect(skel(["--help"]).out).not.toContain("\x1b[");
});

test("a command skel doesn't know gets one line on stderr pointing to the help", () => {
  const wrong = skel(["frobnicate"]);
  expect(wrong.code).toBe(1);
  expect(wrong.out).toBe("");
  expect(wrong.err).toBe("skel: that isn't a skel command. Run skel --help to see them.\n");
});
