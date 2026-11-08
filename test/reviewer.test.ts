// The reviewer, run for real in bubblewrap under a home folder of the test's own, with short
// shell scripts standing in for Codex and Claude Code.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "../src/flow/reviewer.ts";
import { source } from "./harness.ts";

let home = "";
let clone = "";
let commit = "";
let bin = "";
const codexHome = () => join(home, ".local", "share", "skel", "codex");
const sessions = () => join(codexHome(), "sessions");
const issue = { title: "Fix the flaky test", body: "It fails one run in ten." };

// A Sprite's own disk is an overlay, where bwrap can't lay another, while its /tmp is a disk
// of its own. So there the test's home is on the Sprite's own disk, as skel's is.
const sprite = existsSync("/.sprite/api.sock");

// Runs git in the clone and returns what it printed.
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sprite ? homedir() : tmpdir(), "skel-reviewer-test-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  clone = join(home, ".local", "share", "skel", "threads", "app-12");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "README"), "app\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "submitted");
  commit = git("rev-parse", "HEAD");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Without your PATH, which may find a real codex or claude. A Sprite's own tools are kept,
// which tell skel it runs on one.
const env = () => ({
  HOME: home,
  PATH: `${bin}:/usr/local/bin:/usr/bin:/bin${sprite ? ":/.sprite/bin" : ""}`,
  GH_TOKEN: "secret",
  OPENAI_API_KEY: "sk-test",
});

function script(name: string, lines: string[]): void {
  writeFileSync(join(bin, name), ["#!/bin/sh", ...lines].join("\n"), { mode: 0o755 });
}

// Stands in for Codex: keeps what it was given in its sessions folder, which outlasts the
// review, runs `extra`, then answers `answer` where it was asked to.
function fakeCodex(answer: string, extra: string[] = []): void {
  script("codex", [
    'for a; do [ "$prev" = --output-schema ] && schema=$a; [ "$prev" = -o ] && out=$a; prev=$a; done',
    `mkdir -p "$CODEX_HOME/sessions"; cd "$CODEX_HOME/sessions"`,
    'printf "%s\\n" "$@" > args; cat > prompt; cp "$schema" schema; env > env; cd - > /dev/null',
    ...extra,
    `printf '%s' '${answer}' > "$out"`,
  ]);
}

const kept = (name: string) => readFileSync(join(sessions(), name), "utf8");
const approve = '{"verdict":"approve","body":"Looks right."}';
// A review on Codex, unless `more` names another harness.
const given = () => ({
  clone,
  issue,
  base: "origin/main",
  commit,
  model: "opus",
  harness: "codex" as const,
  env: env(),
});
const start = (more: { signal?: AbortSignal; limit?: number; harness?: "claude" } = {}) =>
  review({ ...given(), ...more });

// bubblewrap can't start inside skel's own sandbox, so only there these tests can't run.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("reviewer", () => {
  test("answers with Codex's verdict, given the issue and the base branch", async () => {
    fakeCodex('{"verdict":"changes","body":"The retry has no test."}');
    expect(await start()).toEqual({ verdict: "changes", body: "The retry has no test." });
    const args = kept("args").split("\n");
    // --no-daemon is an option of codex itself, not of exec.
    expect(args.slice(0, 2)).toEqual(["--no-daemon", "exec"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const prompt = kept("prompt");
    for (const part of [issue.title, issue.body, "origin/main", "adversarial", "tests"])
      expect(prompt).toContain(part);
    const schema = JSON.parse(kept("schema"));
    expect(schema.properties.verdict.enum).toEqual(["approve", "changes"]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("passes skel's Codex login and an API key in, and no other secrets", async () => {
    fakeCodex(approve);
    await start();
    const seen = kept("env");
    expect(seen).toContain(`CODEX_HOME=${codexHome()}\n`);
    expect(seen).toContain("OPENAI_API_KEY=sk-test\n");
    expect(seen).not.toContain("GH_TOKEN");
  });

  test("sees the thread's clone through a throwaway layer", async () => {
    fakeCodex(approve, [
      'pwd >> "$CODEX_HOME/sessions/seen"; cat README >> "$CODEX_HOME/sessions/seen"',
      "echo changed > README; echo new > made",
    ]);
    expect(await start()).toEqual({ verdict: "approve", body: "Looks right." });
    expect(kept("seen")).toBe(`${clone}\napp\n`);
    expect(readFileSync(join(clone, "README"), "utf8")).toBe("app\n");
    expect(existsSync(join(clone, "made"))).toBe(false);
  });

  test("leaves nothing behind in the temporary folder, whether it ends or is cancelled", async () => {
    const temporary = join(home, "tmp");
    mkdirSync(temporary);
    fakeCodex(approve, ["echo made > made; sleep 30"]);
    const before = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 1000);
      expect((await start({ signal: cancel.signal })).verdict).toBe("failed");
      expect(readdirSync(temporary)).toEqual([]);
      fakeCodex(approve, ["echo made > made"]);
      expect((await start()).verdict).toBe("approve");
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
    expect(existsSync(join(clone, "made"))).toBe(false);
  });

  test("reviews the commit it is given, whatever the builder changed since", async () => {
    writeFileSync(join(clone, "README"), "later\n");
    git("commit", "-qam", "later");
    writeFileSync(join(clone, "README"), "unsaved\n");
    writeFileSync(join(clone, "new"), "untracked\n");
    fakeCodex(approve, [
      '{ git rev-parse HEAD; cat README; test -e new || echo no-new; } > "$CODEX_HOME/sessions/seen"',
    ]);
    expect(await start()).toEqual({ verdict: "approve", body: "Looks right." });
    expect(kept("seen")).toBe(`${commit}\napp\nno-new\n`);
    expect(readFileSync(join(clone, "README"), "utf8")).toBe("unsaved\n");
  });

  test("keeps Codex's instructions as they were, and its login and sessions writable", async () => {
    mkdirSync(join(codexHome(), "rules"), { recursive: true });
    for (const file of ["config.toml", "AGENTS.md", "rules/default.rules", "auth.json"])
      writeFileSync(join(codexHome(), file), "mine\n");
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "yours\n");
    fakeCodex(approve, [
      'cd "$CODEX_HOME"; echo evil >> config.toml; echo evil > AGENTS.md; echo evil > rules/default.rules',
      "mkdir prompts; echo evil > prompts/review.md",
      "echo renewed > auth.json; echo transcript > sessions/rollout.jsonl",
      'test -e "$HOME/.codex/auth.json" || echo hidden > sessions/yours',
    ]);
    await start();
    for (const file of ["config.toml", "AGENTS.md", "rules/default.rules"])
      expect(readFileSync(join(codexHome(), file), "utf8")).toBe("mine\n");
    expect(existsSync(join(codexHome(), "prompts"))).toBe(false);
    // Codex rewrites its login in place, so a renewal during a review reaches skel's copy.
    expect(readFileSync(join(codexHome(), "auth.json"), "utf8")).toBe("renewed\n");
    expect(kept("rollout.jsonl")).toBe("transcript\n");
    expect(kept("yours")).toBe("hidden\n");
  });

  for (const [what, answer] of [
    ["another verdict", '{"verdict":"maybe","body":"Hm."}'],
    ["a missing body", '{"verdict":"approve"}'],
    ["more than the shape", '{"verdict":"approve","body":"Fine.","score":3}'],
    ["no JSON", "Looks good to me!"],
  ]) {
    test(`fails a review that answers outside the shape: ${what}`, async () => {
      fakeCodex(answer ?? "");
      const done = await start();
      expect(done.verdict).toBe("failed");
      expect(done.body).toContain("shape");
    });
  }

  test("fails a review when Codex fails, saying why", async () => {
    fakeCodex(approve, ["echo 'not logged in' >&2", "exit 1"]);
    const done = await start();
    expect(done.verdict).toBe("failed");
    expect(done.body).toContain("not logged in");
  });

  test("fails a review that runs past its time limit, and ends it", async () => {
    fakeCodex(approve, ['sleep 1; echo late >> "$CODEX_HOME/sessions/late"; sleep 30']);
    const began = Date.now();
    const done = await start({ limit: 300 });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(done.verdict).toBe("failed");
    expect(done.body).toContain("ran past");
    // Whatever the reviewer started ends with it.
    await Bun.sleep(1500);
    expect(existsSync(join(sessions(), "late"))).toBe(false);
  });

  test("fails a review that is cancelled, and ends it", async () => {
    fakeCodex(approve, ['sleep 1; echo late >> "$CODEX_HOME/sessions/late"; sleep 30']);
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 300);
    const done = await start({ signal: cancel.signal });
    expect(done).toEqual({ verdict: "failed", body: "the review was cancelled" });
    await Bun.sleep(1500);
    expect(existsSync(join(sessions(), "late"))).toBe(false);
  });

  test("runs one review at a time, and none that was cancelled while it waited", async () => {
    fakeCodex(approve, [
      'mkdir "$CODEX_HOME/sessions/busy" || echo overlap >> "$CODEX_HOME/sessions/overlap"',
      'echo ran >> "$CODEX_HOME/sessions/ran"; sleep 0.5; rmdir "$CODEX_HOME/sessions/busy"',
    ]);
    const cancel = new AbortController();
    const reviews = [start(), start(), start({ signal: cancel.signal })];
    cancel.abort();
    const [first, second, third] = await Promise.all(reviews);
    expect(first?.verdict).toBe("approve");
    expect(second?.verdict).toBe("approve");
    expect(third?.verdict).toBe("failed");
    expect(kept("ran")).toBe("ran\nran\n");
    expect(existsSync(join(sessions(), "overlap"))).toBe(false);
  });

  // Stands in for Claude Code in print mode. Its config folder is gone after the review,
  // so it reports what it was given in its answer's body.
  function fakeClaude(lines: string[]): void {
    script("claude", [
      "seen=$( (printf '%s\\n' \"$@\"; env | sort | grep -E '^(CLAUDE|GH_)'; pwd; echo x > README; cat README) | base64 -w0)",
      ...lines,
    ]);
  }

  test("reviews on Claude Code with the builder's model", async () => {
    mkdirSync(join(home, ".config", "skel"), { recursive: true });
    writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-tok\n");
    fakeClaude([
      'cat > /dev/null; echo "{\\"type\\":\\"result\\",\\"structured_output\\":{\\"verdict\\":\\"approve\\",\\"body\\":\\"$seen\\"}}"',
    ]);
    const done = await review({ ...given(), harness: "claude", model: "sonnet" });
    expect(done.verdict).toBe("approve");
    const seen = Buffer.from(done.body, "base64").toString().split("\n");
    expect(seen.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
    const schema = JSON.parse(seen[seen.indexOf("--json-schema") + 1] ?? "");
    expect(schema.properties.verdict.enum).toEqual(["approve", "changes"]);
    expect(seen).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-tok");
    expect(seen.some((line) => line.startsWith("CLAUDE_CONFIG_DIR="))).toBe(true);
    expect(seen.some((line) => line.startsWith("GH_"))).toBe(false);
    expect(seen.slice(-3)).toEqual([clone, "x", ""]);
    expect(readFileSync(join(clone, "README"), "utf8")).toBe("app\n");
  });

  test("reviews on Claude Code when your config picks it, though Codex is installed", async () => {
    mkdirSync(join(home, ".config", "skel"), { recursive: true });
    writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-tok\n");
    fakeCodex('{"verdict":"changes","body":"From Codex."}');
    fakeClaude([
      'cat > /dev/null; echo \'{"type":"result","structured_output":{"verdict":"approve","body":"From Claude Code."}}\'',
    ]);
    const done = await review({ ...given(), harness: "claude" });
    expect(done).toEqual({ verdict: "approve", body: "From Claude Code." });
  });

  test("fails a Claude Code review that answers outside the shape", async () => {
    mkdirSync(join(home, ".config", "skel"), { recursive: true });
    writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-tok\n");
    fakeClaude([
      'echo \'{"type":"result","is_error":true,"result":"structured output retries exhausted"}\'',
    ]);
    const done = await start({ harness: "claude" });
    expect(done.verdict).toBe("failed");
    expect(done.body).toContain("shape");
  });
});

// These never start bubblewrap, so they run inside skel's sandbox too.
describe("starting a review", () => {
  // Returns the harness reviews run on with these settings in your skel.yaml, read in a
  // process of its own, as homedir() keeps the HOME this one started with.
  function reviewerFor(settings: string): string {
    mkdirSync(join(home, ".config", "skel"), { recursive: true });
    writeFileSync(join(home, ".config", "skel", "skel.yaml"), settings);
    const code = `import { threadConfig } from ${JSON.stringify(source("config.ts"))};
console.log(threadConfig().reviewer);`;
    const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stdout: "pipe" });
    return run.stdout.toString().trim();
  }

  test("reviews run on your harness, though Codex is installed, unless you name one for them", () => {
    fakeCodex(approve);
    expect(reviewerFor("harness: claude\n")).toBe("claude");
    expect(reviewerFor("harness: claude\nreviewer: { harness: codex }\n")).toBe("codex");
  });

  test("fails a review on a harness your config picks that isn't installed", async () => {
    const done = await review({ ...given(), harness: "codex" });
    expect(done).toEqual({
      verdict: "failed",
      body: "codex isn't installed, and your config picks it for reviews",
    });
  });

  test("fails a Claude Code review when no token is saved", async () => {
    script("claude", ["exit 0"]);
    const done = await start({ harness: "claude" });
    expect(done.verdict).toBe("failed");
    expect(done.body).toContain("run skel");
  });

  test("fails a review cancelled before it started, without running it", async () => {
    fakeCodex(approve);
    const cancel = new AbortController();
    cancel.abort();
    expect(await start({ signal: cancel.signal })).toEqual({
      verdict: "failed",
      body: "the review was cancelled",
    });
    expect(existsSync(join(sessions(), "args"))).toBe(false);
  });
});

test("keeps reviewing after a review that couldn't start", async () => {
  fakeCodex(approve);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(home, "missing");
  try {
    expect((await start()).verdict).toBe("failed");
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
  const cancel = new AbortController();
  cancel.abort();
  expect(await start({ signal: cancel.signal })).toEqual({
    verdict: "failed",
    body: "the review was cancelled",
  });
});
