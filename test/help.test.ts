// Skelcrew's help: what you see with sc --help, and with a command Skelcrew doesn't know.
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("sc --help, -h and help print the help to stdout and succeed", () => {
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
    "rm",
    "attach",
    "review",
    "plugin install",
    "plugin update",
    "plugin setup",
    "plugin rm",
    "plugin ls",
  ])
    expect(out).toContain(`  ${command} `);
});

// --remote keeps Skelcrew on the other side up to date, so there is no command for it.
test("the help names no update command, and says --remote keeps Skelcrew up to date", () => {
  const out = skel(["--help"]).out;
  expect(out).not.toContain("update --remote");
  expect(out).not.toMatch(/^ {2}update/m);
  expect(out).toContain("up to date");
});

// Piped into a file or another program, color codes would be noise.
test("the help has no color when stdout isn't a terminal, or with NO_COLOR", () => {
  expect(skel(["--help"]).out).not.toContain("\x1b[");
});

test("a command Skelcrew doesn't know gets one line on stderr pointing to the help", () => {
  const wrong = skel(["frobnicate"]);
  expect(wrong.code).toBe(1);
  expect(wrong.out).toBe("");
  expect(wrong.err).toBe("Skelcrew: that isn't a Skelcrew command. Run sc --help to see them.\n");
});

// Tools add --json to every command they run, and one that only does something prints the same
// line with it. No daemon runs here, so the command gets as far as asking one.
test("a command that does something takes --json, and does the same", () => {
  const run = mkdtempSync(join(tmpdir(), "skel-help-test-"));
  try {
    const stop = skel(["stop", "app-99", "--json"], { XDG_RUNTIME_DIR: run });
    expect(stop.err).toBe("Skelcrew: the daemon didn't answer: run sc to start it\n");
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test("sc --version from a checkout says so, with its commit", () => {
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
      out: "skelcrew from a checkout, at commit 39939b0\n",
      err: "",
    });
    git(" M src/main.ts");
    expect(skel(["--version"], { PATH: path }).out).toBe(
      "skelcrew from a checkout, at commit 39939b0 with uncommitted changes\n",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sc --version answers on a server whose Skelcrew differs from the laptop's", () => {
  const seen = skel(["--version"], { SKELCREW_LAPTOP_BUILD: "other", SKELCREW_REMOTE_NAME: "x" });
  expect(seen.code).toBe(0);
  expect(seen.out).toStartWith("skelcrew ");
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

test("sc runs from a checkout whose folder it may read files in but not list, as in a Mac's sandbox", () => {
  // A copy of the checkout's parts sc runs from, as the sandbox shows them to an agent.
  const checkout = mkdtempSync(join(tmpdir(), "skelcrew-unlisted-"));
  try {
    cpSync(source(), join(checkout, "src"), { recursive: true });
    cpSync(join(source(), "..", "package.json"), join(checkout, "package.json"));
    symlinkSync(join(source(), "..", "node_modules"), join(checkout, "node_modules"));
    // Its files can be opened by name, but the folder can't be listed.
    chmodSync(checkout, 0o311);
    const run = Bun.spawnSync([process.execPath, join(checkout, "src", "main.ts"), "--version"], {
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString()).toStartWith("skelcrew ");
  } finally {
    chmodSync(checkout, 0o755);
    rmSync(checkout, { recursive: true, force: true });
  }
});

// Tasks and threads are different things, so the help keeps them apart: a task is what you
// want done, in the tracker, and a thread is Skelcrew's work on one.
test("the help lists the task commands in a section of their own, and names threads as threads", () => {
  const out = skel(["--help"]).out;
  const tasks = out.slice(out.indexOf("\nTASKS\n"), out.indexOf("\nREPOSITORIES\n"));
  expect(out).toContain("\nTASKS\n");
  for (const command of ["task ls", "task show", "task create"])
    expect(tasks).toContain(`  ${command} `);
  expect(tasks).not.toContain("  start ");
  for (const command of ["stop", "rm", "attach", "review"])
    expect(out).toContain(`  ${command} <thread>`);
});
