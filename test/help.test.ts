// skel's help: what you see with skel --help, and with a command skel doesn't know.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

const main = source("main.ts");

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
    "remote add",
    "serve",
    "init",
    "repo add",
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
    "plugin install",
    "plugin update",
    "plugin rm",
    "plugin ls",
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

test("skel --version from a checkout says so, with its commit", () => {
  const home = mkdtempSync(join(tmpdir(), "skel-version-test-"));
  try {
    const git = (status: string) => {
      const body = `#!/bin/sh\ncase "$*" in *rev-parse*) echo 39939b0;; *status*) echo "${status}";; esac\n`;
      writeFileSync(join(home, "git"), body, { mode: 0o755 });
    };
    const path = `${home}:${process.env.PATH ?? ""}`;
    git("");
    const clean = skel(["--version"], { PATH: path });
    expect(clean).toEqual({
      code: 0,
      out: "skel from a checkout, at commit 39939b0\n",
      err: "",
    });
    git(" M src/main.ts");
    expect(skel(["--version"], { PATH: path }).out).toBe(
      "skel from a checkout, at commit 39939b0 with uncommitted changes\n",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skel --version answers on a server whose skel differs from the laptop's", () => {
  const seen = skel(["--version"], { SKEL_LAPTOP_BUILD: "other", SKEL_REMOTE_NAME: "x" });
  expect(seen.code).toBe(0);
  expect(seen.out).toStartWith("skel ");
});

test("the help names the sidebar's keys, switching repositories included", () => {
  const out = skel(["--help"]).out.replace(/\s+/g, " ");
  for (const key of [
    "Alt-Up",
    "Alt-Down",
    "Alt-Shift-Up",
    "Alt-Shift-Down",
    "Alt-Left",
    "Alt-Right",
    "Ctrl-Q",
  ])
    expect(out).toContain(key);
});

test("the help names --version", () => {
  expect(skel(["--help"]).out).toContain("--version");
});
