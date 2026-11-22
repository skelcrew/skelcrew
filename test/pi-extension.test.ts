// Skelcrew's extension for Pi, loaded with a fake Pi and a fake sc: what reaches sc's hooks, the
// line it draws above Pi's input, what a review prints and answers, and the words it gives for
// the errors real Pi 1.6.0 wrote, kept in pi-errors.json.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { pi } from "../src/agents/pi.ts";
import skelcrew, {
  busyMark,
  draftLine,
  failureOf,
  type Pi,
  readyLine,
  startedWord,
} from "../src/agents/pi-extension.ts";

const errors = z
  .array(z.object({ api: z.string(), error: z.string(), kind: z.string() }))
  .parse(JSON.parse(readFileSync(join(import.meta.dir, "pi-errors.json"), "utf8")));
const errorOf = (start: string) => errors.find((row) => row.error.startsWith(start))?.error ?? "";

let folder = "";
const path = process.env.PATH;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "skel-pi-extension-test-"));
  const sc = join(folder, "sc");
  writeFileSync(
    sc,
    `#!/bin/sh\n{ printf '%s\\n' "$*"; cat; printf '\\n--\\n'; } >> "${folder}/hooks"\n`,
  );
  chmodSync(sc, 0o755);
  process.env.PATH = `${folder}:${path}`;
});
afterEach(() => {
  process.env.PATH = path;
  delete process.env.SKELCREW_PI_MARK;
  delete process.env.SKELCREW_PI_REVIEW;
  rmSync(folder, { recursive: true, force: true });
});

// The hooks the fake sc was run with, each as its name and what it read on stdin.
const hooks = () =>
  existsSync(join(folder, "hooks"))
    ? readFileSync(join(folder, "hooks"), "utf8")
        .split("\n--\n")
        .filter((run) => run !== "")
        .map((run) => run.split("\n"))
    : [];

type Handler = Parameters<Pi["on"]>[1];
type Tool = Parameters<Pi["registerTool"]>[0];

// Loads the extension into a fake Pi, in the terminal when `ui`, and returns how to send it
// Pi's events, what its line shows, what is typed, and the tools it gave.
function load(ui = true) {
  const handlers = new Map<string, Handler[]>();
  const tools: Tool[] = [];
  let draw: (() => string[]) | null = null;
  const typed = { text: "" };
  const ctx: Parameters<Handler>[1] = {
    hasUI: ui,
    ui: {
      setWidget: (_key, widget) => {
        const component = widget?.({ requestRender: () => {} });
        draw = component ? () => component.render(80) : null;
      },
      getEditorText: () => typed.text,
    },
  };
  skelcrew({
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool) => tools.push(tool),
  });
  const emit = async (name: string, event: Parameters<Handler>[0] = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { emit, line: () => draw?.() ?? [], typed, tools };
}

const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const failed = (errorMessage: string) => ({
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage,
});

test("a lead's or builder's messages, turn ends, Esc and errors reach sc's hooks", async () => {
  const { emit } = load();
  await emit("session_start");
  await emit("input", { text: "Rate limit the API" });
  await emit("agent_start");
  await emit("message_end", { message: answer("Done: the limit is in.") });
  await emit("agent_settled", { aborted: false });
  await emit("agent_start");
  await emit("agent_settled", { aborted: true });
  await emit("agent_start");
  await emit("message_end", { message: failed(errorOf("401:")) });
  await emit("agent_settled", { aborted: false });
  expect(hooks()).toEqual([
    ["hook prompt", JSON.stringify({ prompt: "Rate limit the API" })],
    ["hook turn-ended", JSON.stringify({ last_assistant_message: "Done: the limit is in." })],
    ["hook turn-interrupted", "{}"],
    [
      "hook turn-failed",
      JSON.stringify({
        error: "authentication_failed",
        error_details: "the provider refused Pi's login (401)",
      }),
    ],
  ]);
});

test("a usage limit reaches the turn-failed hook as a limit, with when it resets", async () => {
  const { emit } = load();
  await emit("agent_start");
  await emit("message_end", { message: failed(errorOf("You have hit your ChatGPT")) });
  await emit("agent_settled", { aborted: false });
  const [[name, input] = []] = hooks();
  expect(name).toBe("hook turn-failed");
  const said = z
    .object({ error: z.string(), error_details: z.string() })
    .parse(JSON.parse(input ?? ""));
  expect(said.error).toBe("rate_limit");
  const reset = pi.usageLimit(said.error_details, Date.now())?.reset ?? 0;
  expect(Math.abs(reset - (Date.now() + 42 * 60_000))).toBeLessThan(61_000);
});

test("the line above Pi's input says ready, typed, or working with the seconds", async () => {
  const { emit, line, typed } = load();
  await emit("session_start");
  expect(line()).toEqual([readyLine]);
  typed.text = "half a message";
  expect(line()).toEqual([draftLine]);
  await emit("agent_start");
  expect(line()).toEqual([`${busyMark} 0s`]);
  await emit("agent_settled", { aborted: false });
  typed.text = "";
  expect(line()).toEqual([readyLine]);
});

test("Pi's marks are the ones the extension draws", () => {
  expect(pi.marks).toEqual({ busy: busyMark, prompt: readyLine });
  const screen = ["out", readyLine, "─".repeat(40), "", "─".repeat(40), "~/app"];
  for (const own of [readyLine, draftLine, `${busyMark} 12s`])
    expect(pi.inputStart(screen.with(1, own))).toBe(1);
});

test("each error Pi wrote becomes a kind and words of Skelcrew's own, with nothing of the provider's", () => {
  const own =
    /^(usage limit reached \((429|ChatGPT)\)(, resets at (\w{3} \d{1,2}, )?\d{1,2}:\d{2} [AP]M)?|out of credit \(429\): the provider's account needs paying|Pi's sign-in expired, and Pi couldn't renew it|the provider refused Pi's login \(40[13]\)|the provider failed the request \(\d{3}\))$/;
  for (const { api, error, kind } of errors) {
    const said = failureOf(error, Date.now());
    expect({ api, error, kind: said.kind }).toEqual({ api, error, kind });
    expect(said.words).toMatch(own);
  }
  // A limit is read from the status alone: a body's words for a limit, with no 429, aren't one.
  expect(failureOf('500: {"message":"rate limit exceeded"}', 0).kind).toBe("server_error");
});

test("a review prints its start and its error after its mark, which no command it runs sees", async () => {
  writeFileSync(join(folder, "schema.json"), JSON.stringify({ type: "object" }));
  process.env.SKELCREW_PI_MARK = "mark-1";
  process.env.SKELCREW_PI_REVIEW = folder;
  const printed: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: string) => printed.push(line));
  try {
    const { emit, line } = load(false);
    expect(process.env.SKELCREW_PI_MARK).toBeUndefined();
    expect(process.env.SKELCREW_PI_REVIEW).toBeUndefined();
    await emit("session_start");
    await emit("input", { text: "Review this" });
    await emit("agent_start");
    await emit("message_end", { message: failed(errorOf("429 {")) });
    await emit("agent_settled", { aborted: false });
    expect(line()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  expect(printed).toEqual([`mark-1 ${startedWord}`, "mark-1 usage limit reached (429)"]);
  expect(hooks()).toEqual([]);
});

test("a review's answer goes through a tool whose parameters are the shape", async () => {
  const shape = { type: "object", properties: { verdict: { type: "string" } } };
  writeFileSync(join(folder, "schema.json"), JSON.stringify(shape));
  process.env.SKELCREW_PI_MARK = "mark-1";
  process.env.SKELCREW_PI_REVIEW = folder;
  const [tool] = load(false).tools;
  expect(tool?.parameters).toEqual(shape);
  await tool?.execute("call-1", { verdict: "approve" });
  expect(pi.answer(folder)).toEqual({ verdict: "approve" });
  // A lead or builder gets no such tool.
  expect(load().tools).toEqual([]);
});
