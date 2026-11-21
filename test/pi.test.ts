// Pi as the lead, a builder and the reviewer, as Skelcrew starts it and reads it back. No Pi
// runs, and no sandbox starts, so this runs inside Skelcrew's sandbox too.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pi, piHome } from "../src/agents/pi.ts";
import { noProgress } from "../src/agents/progress.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-pi-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const own = (name: string) => join(home, ".local", "share", "skelcrew", "pi-sessions", name);
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const command = (argv: string[]) => argv.slice(argv.indexOf("pi"));

const start = (given: Partial<Parameters<typeof pi.start>[0]> = {}) =>
  pi.start({
    name: "app-12",
    socket: join(home, "socket"),
    thread: join(home, "app-12"),
    prompt: "Add export",
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    ...(given.resume ? {} : { sessionId: "6f0c5f1e-0000-4000-8000-000000000001" }),
    ...given,
  });

test("a Pi builder starts in its own session, with nothing of the repository's but AGENTS.md", () => {
  const { argv, env } = start({ model: "google/gemini-4-neon:high", system: "Be careful." });
  const run = command(argv);
  expect(run[0]).toBe("pi");
  for (const off of ["-ne", "-ns", "-np", "--no-themes", "-na"]) expect(run).toContain(off);
  expect(after(run, "--session-dir")).toBe(join(own("app-12"), "sessions"));
  expect(after(run, "--session-id")).toBe("6f0c5f1e-0000-4000-8000-000000000001");
  expect(after(run, "--model")).toBe("google/gemini-4-neon:high");
  expect(readFileSync(after(run, "--append-system-prompt") ?? "", "utf8")).toBe("Be careful.");
  expect(run.slice(-2)).toEqual(["--", "Add export"]);
  expect(readFileSync(after(run, "-e") ?? "", "utf8")).toContain('hook("turn-ended"');
  expect(env.PI_CODING_AGENT_DIR).toBe(join(own("app-12"), "agent"));
  expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
});

test("a resumed Pi session opens the same session, without its first message again", () => {
  const { argv } = start({ resume: "6f0c5f1e-0000-4000-8000-000000000001" });
  const run = command(argv);
  expect(after(run, "--session-id")).toBe("6f0c5f1e-0000-4000-8000-000000000001");
  expect(run).not.toContain("Add export");
  expect(() =>
    start({
      sessionId: "6f0c5f1e-0000-4000-8000-000000000001",
      resume: "6f0c5f1e-0000-4000-8000-000000000001",
    }),
  ).toThrow("both new and resumed");
  expect(() => start({ sessionId: "-x" })).toThrow();
});

test("each start gets a fresh copy of Skelcrew's own Pi login and models, never yours", () => {
  mkdirSync(piHome(home), { recursive: true });
  writeFileSync(join(piHome(home), "auth.json"), '{"google":{"type":"api_key","key":"k1"}}');
  writeFileSync(join(piHome(home), "models.json"), '{"providers":{}}');
  const agent = join(own("app-12"), "agent");
  start();
  expect(readFileSync(join(agent, "auth.json"), "utf8")).toContain("k1");
  // The agent can write its folder: what it left is replaced, and a link is never followed.
  const yours = join(home, "yours.json");
  writeFileSync(yours, "mine");
  rmSync(join(agent, "auth.json"));
  symlinkSync(yours, join(agent, "auth.json"));
  writeFileSync(join(agent, "skelcrew.js"), "planted");
  rmSync(join(piHome(home), "models.json"));
  start();
  expect(readFileSync(yours, "utf8")).toBe("mine");
  expect(lstatSync(join(agent, "auth.json")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(agent, "skelcrew.js"), "utf8")).not.toBe("planted");
  expect(existsSync(join(agent, "models.json"))).toBe(false);
});

test("a Pi session's conversation is found by its ID once Pi saved it", () => {
  const name = `pi-saved-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  expect(pi.saved(name, "/work", id)).toBeNull();
  const sessions = join(homedir(), ".local", "share", "skelcrew", "pi-sessions", name, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `2026-11-21T21-41-06-229Z_${id}.jsonl`), "{}\n");
  try {
    expect(pi.saved(name, "/work", id)).toBe(id);
    expect(pi.conversation(name, "/work", id)).toBe(
      join(sessions, `2026-11-21T21-41-06-229Z_${id}.jsonl`),
    );
    expect(pi.saved(name, "/work", crypto.randomUUID())).toBeNull();
  } finally {
    rmSync(join(sessions, ".."), { recursive: true, force: true });
  }
});

const answer = (usage: object, ...content: object[]) =>
  JSON.stringify({
    type: "message",
    id: "a",
    parentId: null,
    timestamp: "2026-11-21T21:32:44.149Z",
    message: { role: "assistant", content, usage, stopReason: "toolUse" },
  });
const call = (name: string, args: object) => ({ type: "toolCall", id: "c", name, arguments: args });

test("Pi: the sidebar reads its tokens and its latest step from the session file", () => {
  const usage = (input: number, output: number) => ({
    input,
    output,
    cacheRead: 9000,
    cacheWrite: 50,
  });
  const lines = [
    '{"type":"session","version":3,"id":"x","cwd":"/work"}',
    answer(usage(100, 20), call("read", { path: "/work/src/main.ts" })),
    "not json",
    answer(
      usage(200, 30),
      { type: "text", text: "Now the edit." },
      call("edit", { path: "src/a.ts" }),
    ),
  ];
  const read = pi.progress(lines, noProgress);
  expect(read.tokens).toBe(450);
  expect(read.step).toBe("Editing a.ts");
  expect(read.plan).toBeNull();
  expect(pi.progress([answer(usage(0, 0), call("bash", { command: "ls" }))], read).step).toBeNull();
  expect(pi.progress([answer(usage(0, 0), call("read", { path: "x/b.md" }))], read).step).toBe(
    "Reading b.md",
  );
});

const rule = "─".repeat(40);

test("Pi's input area is its › prompt between two rules, with its footer under them", () => {
  const screen = [
    " Hello from the model.",
    " ⠹ esc to interrupt",
    rule,
    "› a draft",
    "  on two lines",
    rule,
    "/work (main)",
    "↑100 ↓20 0.1%/128k (auto)       (google) gemini-4-neon",
  ];
  expect(pi.inputStart(screen)).toBe(2);
  expect(pi.inputStart([rule, "›", rule, "/work (main)"])).toBe(0);
  // A › line of the agent's own, with no rules around it, is its output.
  expect(pi.inputStart(["› quoted", "more output"])).toBeNull();
});

test("a Pi review answers through its own tool, held to the review's shape", () => {
  mkdirSync(piHome(home), { recursive: true });
  writeFileSync(join(piHome(home), "auth.json"), "{}");
  const folder = join(home, "review");
  mkdirSync(folder);
  const schema = '{"type":"object","properties":{"verdict":{"type":"string"}}}';
  const launch = pi.review({ home, folder, model: "openrouter/qwen3.8-max", schema });
  expect(launch.command.slice(0, 3)).toEqual(["pi", "-p", "--no-session"]);
  expect(after(launch.command, "--model")).toBe("openrouter/qwen3.8-max");
  const extension = readFileSync(after(launch.command, "-e") ?? "", "utf8");
  expect(extension).toContain(`parameters: ${schema}`);
  expect(extension).toContain(JSON.stringify(join(folder, "answer.json")));
  expect(launch.env.PI_CODING_AGENT_DIR).toBe(join(folder, "pi"));
  expect(existsSync(join(folder, "pi", "auth.json"))).toBe(true);
  expect(() => pi.answer(folder)).toThrow("it gave no answer");
  writeFileSync(join(folder, "answer.json"), '{"verdict":"approve","body":"ok","findings":[]}');
  expect(pi.answer(folder)).toEqual({ verdict: "approve", body: "ok", findings: [] });
});

test("a Pi reviewer's error is what Pi printed on stderr, and a 429 is a usage limit", () => {
  const now = new Date(2026, 10, 16, 10, 30).getTime();
  const err =
    'Warning: Model "x" not found for provider "google". Using custom model id.\n429: {"message":"You exceeded your current quota. Try again later."}\n';
  const error = pi.failure("", err);
  expect(error).toBe('429: {"message":"You exceeded your current quota. Try again later."}');
  expect(pi.usageLimit(error ?? "", now)).toEqual({ reset: null });
  expect(pi.usageLimit("Rate limit reached, try again at 1:59 PM", now)).toEqual({
    reset: new Date(2026, 10, 16, 13, 59).getTime(),
  });
  expect(pi.usageLimit("Unexpected token 'r', not valid JSON", now)).toBeNull();
  expect(pi.failure("", "Warning: fd not found.\n")).toBeNull();
});
