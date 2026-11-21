// Skelcrew's help: what you see with sc --help, and with a command Skelcrew doesn't know.
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    "task add",
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
      out: "Skelcrew 39939b0 (checkout)\n",
      err: "",
    });
    git(" M src/main.ts");
    expect(skel(["--version"], { PATH: path }).out).toBe(
      "Skelcrew 39939b0* (checkout, * = uncommitted changes)\n",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sc --version answers on a server whose Skelcrew differs from the laptop's", () => {
  const seen = skel(["--version"], { SKELCREW_LAPTOP_BUILD: "other", SKELCREW_REMOTE_NAME: "x" });
  expect(seen.code).toBe(0);
  expect(seen.out).toStartWith("Skelcrew ");
});

// The screen's keys, in words: those that work anywhere, then those for the sidebar.
test("the help lists the screen's keys, anywhere first, then the sidebar's", () => {
  const out = skel(["--help"]).out;
  const keys = out.slice(out.indexOf("\nKEYS\n"), out.indexOf("\nEXAMPLES\n"));
  const order = [
    "ctrl + \\ ",
    "alt + ↑/↓ ",
    "alt + 1-6 ",
    "alt + w, w ",
    "alt + q ",
    "enter ",
    "shift + enter, a ",
    "s ",
    "m ",
    "shift + r ",
  ].map((key) => keys.indexOf(`\n  ${key}`));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(keys).toMatch(/\n {2}m +merge a ready task\n/);
  expect(keys).toMatch(/\n {2}shift \+ enter, a +type to the row's agent full screen\n/);
  expect(keys).not.toContain("alt + ←");
  expect(keys).toMatch(/\n {2}shift \+ ↑\/↓ +move a queued task in up next\n/);
  expect(keys).toMatch(/\n {2}s +start or queue a task in the backlog\n/);
  expect(keys).toMatch(/\n {2}shift \+ r +restart the row's agent, keeping its conversation\n/);
  expect(out).not.toContain("ctrl + q");
  expect(out).not.toContain("⌃Q");
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
    expect(run.stdout.toString()).toStartWith("Skelcrew ");
  } finally {
    chmodSync(checkout, 0o755);
    rmSync(checkout, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// An issue is only where some tasks come from, and a PR is part of a task, so the help has no
// commands of their own for them: the task commands cover both. A thread is an agent on a task.
test("the help has no issue or PR commands, and names tasks and threads as such", () => {
  const out = skel(["--help"]).out;
  expect(out).not.toContain("\nISSUES\n");
  expect(out).not.toContain("\nPULL REQUESTS\n");
  expect(out).not.toContain("  issue ");
  expect(out).not.toContain("  pr ");
  expect(out).toContain("  show <task> ");
  expect(out).not.toContain("show <task> | <#pr>");
  expect(out).toContain("  --issue ");
  expect(out).toContain("  --keep-issue ");
  for (const command of ["stop", "attach", "peek", "interrupt", "tell"])
    expect(out).toContain(`  ${command} <thread>`);
  for (const command of ["show", "rm", "review"]) expect(out).toContain(`  ${command} <task>`);
});

// sc issue and sc pr are gone. Leads started before then may still type them, so what replaced
// them is named.
test("sc issue and sc pr say which task commands replaced them", () => {
  for (const args of [
    ["issue", "create", "app", "t", "b"],
    ["pr", "show", "7"],
  ]) {
    const ran = skel(args);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("sc show <task> shows one with its PR");
    expect(ran.err).toContain("--issue");
  }
});

// A task with no issue has a name of Skelcrew's, names show in uppercase and are typed in any
// case, which only the help tells someone new.
test("the help says how a task with no issue is named, and that names are typed in any case", () => {
  const out = skel(["--help"]).out.replace(/\s+/g, " ");
  expect(out).toContain("started with no issue, by a T and a number, such as APP-T100.");
  expect(out).toContain("Type a name in any case: app-t100 is APP-T100.");
});

// sc task only files tasks: sc ls and sc show list and show them.
test("sc task takes only add", () => {
  const ran = skel(["task", "ls"]);
  expect(ran.code).not.toBe(0);
  expect(ran.err).toContain("sc task was given arguments it doesn't take");
});

// The lead names each thread it starts for the sidebar, and you can too.
test("the help says sc start takes a short title and a flow", () => {
  expect(skel(["--help"]).out).toContain('  --short "<words>" ');
  expect(skel(["--help"]).out).toContain("  --flow <name> ");
});
