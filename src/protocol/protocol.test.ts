import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import { encode, MAX_LINE, parseReply, parseRequest } from "./protocol";

const spec = { scope: "Export CSV.", acceptance: ["It downloads."], openQuestions: [] };

describe("parseRequest", () => {
  test("reads each command the CLI sends", () => {
    const commands = [
      { type: "add", title: "CSV export", spec: true, project: null },
      { type: "spec", task: 12 },
      { type: "approve", task: 12 },
      { type: "reject", task: 12, note: "Split it." },
      { type: "drop", task: 12 },
      { type: "retry", task: 12 },
      { type: "status" },
      { type: "log", task: 12 },
      { type: "claim", task: 12 },
      { type: "submit", task: 12, session: "you-1", spec },
      { type: "done", task: 12, session: "you-1" },
      { type: "give_up", task: 12, session: "you-1", message: "Stuck." },
      { type: "project_new", name: "Reports page", goal: "Export what it shows." },
      { type: "project_add", task: 12, project: "reports-page" },
      { type: "project_remove", task: 12 },
      { type: "project_archive", project: "Reports page" },
      { type: "project_unarchive", project: "reports-page" },
    ];
    for (const command of commands) {
      const line = JSON.stringify({ id: "r1", command });
      expect<unknown>(parseRequest(line)).toEqual({ ok: true, value: { id: "r1", command } });
    }
  });

  // A project always has a name and a goal, and is named in each command.
  test("refuses a project with no name or goal, or a command that names none", () => {
    for (const command of [
      { type: "project_new", name: " ", goal: "Export what it shows." },
      { type: "project_new", name: "Reports page", goal: "" },
      { type: "project_add", task: 12, project: "" },
      { type: "project_archive", project: " " },
    ]) {
      expect(parseRequest(JSON.stringify({ id: "r1", command })).ok).toBe(false);
    }
  });

  // Only a session proves a report comes from the task's agent.
  test("refuses an agent's report without its session", () => {
    const line = JSON.stringify({ id: "r1", command: { type: "done", task: 12 } });
    expect(parseRequest(line).ok).toBe(false);
  });

  // Sending back is its own command, so an approve can't carry a note.
  test("refuses an approve that carries a note to send it back", () => {
    const command = { type: "approve", task: 12, sendBack: "Split it." };
    expect(parseRequest(JSON.stringify({ id: "r1", command })).ok).toBe(false);
  });

  // Sending work back always says what to change.
  test("refuses a reject without a note, or with a blank one", () => {
    for (const command of [
      { type: "reject", task: 12 },
      { type: "reject", task: 12, note: "" },
      { type: "reject", task: 12, note: "  \n" },
    ]) {
      expect(parseRequest(JSON.stringify({ id: "r1", command })).ok).toBe(false);
    }
  });

  test("refuses a command it doesn't know", () => {
    const line = JSON.stringify({ id: "r1", command: { type: "merge", task: 12 } });
    expect(parseRequest(line).ok).toBe(false);
  });

  test("refuses a field it doesn't know, so a typo can't be silently ignored", () => {
    const line = JSON.stringify({ id: "r1", command: { type: "drop", task: 12, force: true } });
    expect(parseRequest(line).ok).toBe(false);
  });

  test("refuses a task number that isn't a whole number above zero", () => {
    for (const task of [0, -1, 1.5, "12"]) {
      const line = JSON.stringify({ id: "r1", command: { type: "drop", task } });
      expect(parseRequest(line).ok).toBe(false);
    }
  });

  test("says so when the line isn't JSON", () => {
    expect(parseRequest("{not json")).toEqual({
      ok: false,
      message: "The request isn't valid JSON.",
    });
  });

  // A client that never ends its line mustn't make the daemon read for ever.
  test("refuses a line longer than the limit", () => {
    const line = JSON.stringify({
      id: "r1",
      command: { type: "add", title: "x".repeat(MAX_LINE), spec: false, project: null },
    });
    expect(parseRequest(line)).toEqual({
      ok: false,
      message: `The request is longer than ${MAX_LINE} bytes.`,
    });
  });
});

describe("parseReply", () => {
  test("reads a reply with a result, and one with a refusal", () => {
    const answered = { id: "r1", ok: true, result: { passed: false, summary: "2 tests failed" } };
    const refused = { id: "r1", ok: false, message: "#12 is blocked." };
    expect<unknown>(parseReply(JSON.stringify(answered))).toEqual({ ok: true, value: answered });
    expect<unknown>(parseReply(JSON.stringify(refused))).toEqual({ ok: true, value: refused });
  });

  test("refuses a reply without an id", () => {
    expect(parseReply(JSON.stringify({ ok: true, result: {} })).ok).toBe(false);
  });
});

describe("encode", () => {
  test("writes one line that reads back the same", () => {
    const request = { id: "r1", command: { type: "log" as const, task: TaskId.parse(12) } };
    const line = encode(request);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseRequest(line.slice(0, -1))).toEqual({ ok: true, value: request });
  });
});
