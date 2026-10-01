import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionId, TaskId } from "../../core/ids";
import { ClaudeCode } from "./claude-code";

const uuid = "11111111-2222-3333-4444-555555555555";
const worktree = "/repo/.skelcrew/worktrees/12-csv-export";
const specCopy = "/repo/.skelcrew/spec-worktrees/12-csv-export";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// A Claude Code config folder of its own, so no test reads yours.
function configFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-claude-"));
  dirs.push(dir);
  return dir;
}

const claude = (configDir = "/nowhere") => new ClaudeCode({ configDir, newId: () => uuid });

describe("launch", () => {
  test("starts a develop agent on its task, refusing what would ask, with edits in its worktree", () => {
    const launch = claude().launch({
      taskId: TaskId.parse(12),
      kind: "develop",
      session: SessionId.parse("session-k3x9q2mf"),
      cwd: worktree,
    });
    expect(launch).toEqual({
      command: [
        "claude",
        "--session-id",
        uuid,
        "--permission-mode",
        "dontAsk",
        "--settings",
        JSON.stringify({ permissions: { allow: ["Bash(skelcrew *)", `Edit(/${worktree}/**)`] } }),
        "/develop 12 --background",
      ],
      env: { SKELCREW_TASK: "12", SKELCREW_SESSION: "session-k3x9q2mf" },
      harnessSession: uuid,
    });
  });

  // A spec agent shouldn't change code, so it gets no edits. Every agent
  // may run skelcrew, to report: the daemon refuses your commands from an
  // agent, and the ask rules for approve and reject refuse them here.
  test("starts a spec agent that may run skelcrew, with no edits added", () => {
    const launch = claude().launch({
      taskId: TaskId.parse(12),
      kind: "spec",
      session: SessionId.parse("session-k3x9q2mf"),
      cwd: specCopy,
    });
    expect(launch.command).toEqual([
      "claude",
      "--session-id",
      uuid,
      "--permission-mode",
      "dontAsk",
      "--settings",
      JSON.stringify({ permissions: { allow: ["Bash(skelcrew *)"] } }),
      "/spec 12 --background",
    ]);
  });

  test("names the harness", () => {
    expect(claude().name).toBe("claude-code");
  });
});

// One line of a transcript, as Claude Code writes them.
const start = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const prompt = (seconds: number, text: string) =>
  JSON.stringify({
    type: "user",
    timestamp: at(seconds),
    message: { role: "user", content: text },
  });
const toolResult = (seconds: number) =>
  JSON.stringify({
    type: "user",
    timestamp: at(seconds),
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  });
const reply = (
  seconds: number,
  id: string,
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number },
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(seconds),
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
      },
    },
  });
const system = (seconds: number) => JSON.stringify({ type: "system", timestamp: at(seconds) });

// Claude Code keeps a session's transcript in a folder named after the
// worktree. The name's exact form is Claude Code's, so it is found by the
// session's ID instead.
function transcript(configDir: string, lines: string[]): void {
  const folder = join(configDir, "projects", "-repo--skelcrew-worktrees-12-csv-export");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${uuid}.jsonl`), `${lines.join("\n")}\n`);
}

describe("usage", () => {
  test("counts each reply once, leaves cache reads out, and counts only working time", async () => {
    const dir = configFolder();
    transcript(dir, [
      // The first prompt: two replies, the first written over two lines,
      // and a tool result between them. 4.1 seconds of work.
      prompt(0, "/develop 12"),
      reply(1, "msg-a", { input: 10, output: 5, cacheWrite: 100, cacheRead: 1000 }),
      reply(1.5, "msg-a", { input: 10, output: 5, cacheWrite: 100, cacheRead: 1000 }),
      toolResult(2),
      reply(4, "msg-b", { input: 2, output: 20, cacheWrite: 0, cacheRead: 2000 }),
      system(4.1),
      // The agent waits an hour for your answer, which doesn't count.
      prompt(3604, "No"),
      reply(3606, "msg-c", { input: 1, output: 1, cacheWrite: 0, cacheRead: 500 }),
    ]);
    expect(await claude(dir).usage(worktree, uuid)).toEqual({
      ok: true,
      // 10 + 5 + 100, then 2 + 20, then 1 + 1.
      value: { tokens: 139, cacheReads: 3500, workingMs: 6100 },
    });
  });

  test("is nothing for a session with no transcript yet", async () => {
    expect(await claude(configFolder()).usage(worktree, uuid)).toEqual({
      ok: true,
      value: { tokens: 0, cacheReads: 0, workingMs: 0 },
    });
  });

  // Claude Code may be partway through writing a line.
  test("skips a line it can't read", async () => {
    const dir = configFolder();
    transcript(dir, [
      prompt(0, "/develop 12"),
      reply(2, "msg-a", { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }),
      '{"type":"assistant","timest',
    ]);
    expect(await claude(dir).usage(worktree, uuid)).toEqual({
      ok: true,
      value: { tokens: 6, cacheReads: 4, workingMs: 2000 },
    });
  });
});
