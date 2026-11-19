// Skelcrew's help: what you see with sc --help, and with a command Skelcrew doesn't know.
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyLines } from "../src/screen/keys.ts";
import { source } from "./harness.ts";

const main = source("main.ts");

// Runs sc with no home. The run's own runtime folder, with no daemon in it, keeps a command
// that asks the daemon from finding yours in /run/user.
function skel(args: string[], env: Record<string, string> = {}) {
  const runtime = process.env.XDG_RUNTIME_DIR ?? "";
  const run = Bun.spawnSync([process.execPath, main, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_RUNTIME_DIR: runtime, ...env },
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
    "--list",
    "--remote",
    "--remote <host> install",
    "--remote <host> up --bg",
    "up",
    "up --bg",
    "init",
    "repo add",
    "repo ls",
    "repo rm",
    "repo trust",
    "ps",
    "ls",
    "show",
    "issue ls",
    "issue show",
    "issue create",
    "pr show",
    "start",
    "stop",
    "rm",
    "attach",
    "peek",
    "interrupt",
    "review",
    "install",
    "add -g",
    "update -g",
    "setup",
    "remove -g",
    "plugins",
  ])
    expect(out).toContain(`  ${command} `);
});

// --remote keeps Skelcrew on the other side up to date, so there is no command for it. The one
// update command is for your plugins.
test("the help names no update command for Skelcrew, and says --remote keeps it up to date", () => {
  const out = skel(["--help"]).out;
  expect(out).not.toContain("update --remote");
  expect(out.match(/^ {2}update.*/gm)).toEqual([expect.stringContaining("update -g [<name>]")]);
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

// The screen's keys, in words, as the list of keys shows them.
test("the help lists the screen's keys, anywhere first, then lists, then pages", () => {
  const out = skel(["--help"]).out;
  const keys = out.slice(out.indexOf("\nKEYS\n"), out.indexOf("\nEXAMPLES\n"));
  const order = ["alt + ↑/↓ ", "alt + shift + ←/→ ", "alt + q ", "enter/→ ", "← "].map((key) =>
    keys.indexOf(`  ${key}`),
  );
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(out).not.toContain("ctrl + q");
  expect(out).not.toContain("⌃Q");
});

// s and m work on a list and on the page opened from it, so they come after the other keys
// for lists and before those for pages.
test("the help lists s to start a thread on an issue and m to merge a PR, after the keys for lists", () => {
  const out = skel(["--help"]).out;
  const keys = out.slice(out.indexOf("\nKEYS\n"), out.indexOf("\nEXAMPLES\n"));
  const order = ["enter/→ ", "s ", "m ", "← "].map((key) => keys.indexOf(`\n  ${key}`));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(keys).toMatch(/\n {2}s +start a thread on an issue\n/);
  expect(keys).toMatch(/\n {2}m +merge a ready PR\n/);
});

// The list of keys runs across the whole screen, above the footer.
test("across a 120-column terminal, the list of keys fits in three columns and four rows", () => {
  const lines = keyLines(120);
  expect(lines).toHaveLength(4);
  expect(lines[0]?.trim().split(/\s{3,}/)).toHaveLength(3);
  expect(lines.join("\n")).toContain("m to merge a ready PR");
});

test("the keys have no Alt-/, as ? on a list or a page shows and hides them", () => {
  expect(keyLines(200).join("\n")).not.toContain("alt + /");
  expect(skel(["--help"]).out).not.toContain("alt + /");
  expect(keyLines(200).join("\n")).toContain("? to show or hide these keys");
});

test("the help names --version", () => {
  expect(skel(["--help"]).out).toContain("--version");
});

test("sc runs from a checkout whose folder it may read files in but not list, as in a Mac's sandbox", () => {
  // A copy of the checkout's parts sc runs from, as the sandbox shows them to an agent.
  const checkout = mkdtempSync(join(tmpdir(), "skelcrew-unlisted-"));
  const cache = mkdtempSync(join(tmpdir(), "skelcrew-bun-cache-"));
  try {
    cpSync(source(), join(checkout, "src"), { recursive: true });
    cpSync(join(source(), "..", "package.json"), join(checkout, "package.json"));
    symlinkSync(join(source(), "..", "node_modules"), join(checkout, "node_modules"));
    // Its files can be opened by name, but the folder can't be listed.
    chmodSync(checkout, 0o311);
    // With no home, Bun keeps its cache in node_modules/.cache and, on a slow disk such as a CI
    // runner's, warns about it on stderr. A cache folder of its own keeps that warning out, so
    // stderr shows only what sc itself says.
    const run = Bun.spawnSync([process.execPath, join(checkout, "src", "main.ts"), "--version"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/nonexistent",
        BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
      },
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString()).toStartWith("skelcrew ");
  } finally {
    chmodSync(checkout, 0o755);
    rmSync(checkout, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// Issues, tasks and threads are different things, so the help keeps them apart: an issue is
// what you want done, in the tracker, a task is Skelcrew's record of the work on one, and a
// thread is an agent on a task. The sidebar's list is called ISSUES, so the commands for the
// tracker use the same word.
test("the help lists the issue commands in a section of their own, and names tasks and threads as such", () => {
  const out = skel(["--help"]).out;
  const issues = out.slice(out.indexOf("\nISSUES\n"), out.indexOf("\nREPOSITORIES\n"));
  expect(out).toContain("\nISSUES\n");
  for (const command of ["issue ls", "issue show", "issue create"])
    expect(issues).toContain(`  ${command} `);
  expect(issues).not.toContain("  start ");
  for (const command of ["stop", "attach", "peek", "interrupt", "tell"])
    expect(out).toContain(`  ${command} <thread>`);
  for (const command of ["show", "rm", "review"]) expect(out).toContain(`  ${command} <task>`);
});

// The issue commands replaced the task commands, which are gone with no alias.
test("sc task is no longer a command", () => {
  const ran = skel(["task", "ls"]);
  expect(ran.code).not.toBe(0);
  expect(ran.err).toContain("that isn't a Skelcrew command");
});

// The lead names each thread it starts for the sidebar, and you can too.
test("the help says sc start takes a short title and a flow", () => {
  expect(skel(["--help"]).out).toContain('  --short "<words>" ');
  expect(skel(["--help"]).out).toContain("  --flow <name> ");
});
