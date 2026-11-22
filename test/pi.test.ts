// Pi as a harness. Skelcrew's extension is loaded as Pi loads it and driven by a fake Pi, with a
// fake sc that keeps each hook it is run with. The rest is the Pi module, under a home of the
// test's own.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { pi, piLoggedIn } from "../src/agents/pi.ts";
import skelcrew, {
  busyMark,
  isUsageLimit,
  readyMark,
  verdictTool,
} from "../src/agents/pi-extension.ts";
import { quietSince } from "../src/agents/transport.ts";

let home = "";
const data = () => join(home, ".local", "share", "skelcrew");
const login = () => join(data(), "pi-login", "auth.json");

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-pi-test-")));
  mkdirSync(join(home, "bin"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// What Pi gives a handler besides its event: whether it has a screen, whether it is idle, what is
// typed at its input, and the credentials it resolves for its model. Each widget set is kept.
function fakeContext(
  given: { idle?: boolean; typed?: string; hasUI?: boolean; auth?: unknown } = {},
) {
  const state = { idle: given.idle ?? true, typed: given.typed ?? "" };
  const widgets: (string[] | undefined)[] = [];
  const model = { provider: "openrouter", id: "some-model" };
  const ctx = {
    hasUI: given.hasUI ?? true,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async (asked: unknown) =>
        asked === model ? (given.auth ?? { ok: true }) : { ok: false, error: "no such model" },
    },
    isIdle: () => state.idle,
    ui: {
      setWidget: (_key: string, lines: string[] | undefined) => void widgets.push(lines),
      getEditorText: () => state.typed,
    },
  };
  return { ctx, state, widgets };
}

type Ctx = ReturnType<typeof fakeContext>["ctx"];
type Tool = { name: string; parameters: unknown; execute: (id: string, given: unknown) => unknown };

// Stands in for Pi: loads the extension as Pi does, keeps its handlers and tools, and runs each
// handler of an event in turn, waiting for it, as Pi does.
function fakePi(env: Record<string, string> = {}) {
  const handlers = new Map<string, ((event: unknown, ctx: Ctx) => unknown)[]>();
  const tools: Tool[] = [];
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    skelcrew({
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      registerTool: (tool) => void tools.push(tool),
    });
  } finally {
    for (const key of Object.keys(env)) {
      const was = before[key];
      if (was === undefined) delete process.env[key];
      else process.env[key] = was;
    }
  }
  const emit = async (event: string, given: unknown = {}, ctx = fakeContext().ctx) => {
    for (const handler of handlers.get(event) ?? []) await handler(given, ctx);
  };
  return { emit, tools };
}

// A fake sc on the PATH keeps each hook it runs, a line each, with what came on stdin.
const hooksFile = () => join(home, "hooks");
function fakeSc(): void {
  writeFileSync(
    join(home, "bin", "sc"),
    `#!/bin/sh\n{ printf '%s ' "$@"; printf '| '; cat; echo; } >> "${hooksFile()}"\n`,
    { mode: 0o755 },
  );
}
const hooks = () => (existsSync(hooksFile()) ? readFileSync(hooksFile(), "utf8").trimEnd() : "");

// An answer Pi ends a run with, as agent_end gives it, after the user's message.
const answer = (message: object) => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", ...message },
  ],
});

describe("the extension in a lead or a builder", () => {
  const path = process.env.PATH;
  beforeEach(() => {
    fakeSc();
    process.env.PATH = `${join(home, "bin")}:${path ?? ""}`;
  });
  afterEach(() => {
    process.env.PATH = path;
  });

  test("a message typed in runs the prompt hook with its words, and the turn's end the Stop hook", async () => {
    const { emit } = fakePi();
    await emit("input", { text: "Fix the test\nplease", source: "interactive" });
    const parts = [
      { type: "thinking", thinking: "hm" },
      { type: "text", text: "Done. " },
    ];
    await emit(
      "agent_end",
      answer({ content: [...parts, { type: "text", text: "Pushed?" }], stopReason: "stop" }),
    );
    await emit("agent_settled", { aborted: false });
    expect(hooks()).toBe(
      [
        'hook prompt | {"prompt":"Fix the test\\nplease"}',
        'hook turn-ended | {"last_assistant_message":"Done. Pushed?"}',
      ].join("\n"),
    );
  });

  test("a message another extension sends runs no hook, as nobody typed it", async () => {
    const { emit } = fakePi();
    await emit("input", { text: "from code", source: "extension" });
    expect(hooks()).toBe("");
  });

  test("Esc runs the hook for an interrupted turn", async () => {
    const { emit } = fakePi();
    await emit("agent_end", answer({ content: [], stopReason: "aborted" }));
    await emit("agent_settled", { aborted: true });
    expect(hooks()).toBe("hook turn-interrupted | {}");
  });

  test("a usage limit ends the turn as a rate limit, after Pi's retries, with Pi's words", async () => {
    const { emit } = fakePi();
    const limit = '429: {"message":"You exceeded your current quota. Try again at 3:15 PM."}';
    // Pi tries three times, and each try ends a run.
    for (let i = 0; i < 3; i++)
      await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: limit }));
    await emit("agent_settled", { aborted: false });
    const said = JSON.stringify({ error: "rate_limit", error_details: limit });
    expect(hooks()).toBe(`hook turn-failed | ${said}`);
  });

  test("a key in Pi's error never reaches Skelcrew, whether in the environment or shaped like one", async () => {
    const { emit } = fakePi();
    const before = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "or-secret-1234567890";
    try {
      const error =
        "401: key or-secret-1234567890 refused, also sk-ant-api03-abcdefghij, AIzaSyA1234567890abcdefghijk, Bearer eyJhbGciOi.xyz";
      await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: error }));
      await emit("agent_settled", { aborted: false });
    } finally {
      process.env.OPENROUTER_API_KEY = before;
    }
    const said = "401: key [key] refused, also [key], [key], Bearer [key]";
    expect(hooks()).toBe(
      `hook turn-failed | ${JSON.stringify({ error: "error", error_details: said })}`,
    );
  });

  // A key pi auth login saved, or one Pi ran a command for, is in no variable, and can be short.
  test("the key and headers Pi sends for its model are taken out of its error, however short", async () => {
    const { emit } = fakePi();
    const auth = { ok: true, apiKey: "k3y", headers: { Authorization: "Token zq9-short" } };
    const { ctx } = fakeContext({ auth });
    const error = "401: k3y and zq9-short refused, k3yboard and Token stay";
    await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: error }), ctx);
    await emit("agent_settled", { aborted: false }, ctx);
    const said = "401: [key] and [key] refused, k3yboard and Token stay";
    expect(hooks()).toBe(
      `hook turn-failed | ${JSON.stringify({ error: "error", error_details: said })}`,
    );
  });

  test("an error that only mentions a quota is an error, not a usage limit", async () => {
    const { emit } = fakePi();
    const error = '403: {"message":"quota project not set"}';
    await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: error }));
    await emit("agent_settled", { aborted: false });
    expect(hooks()).toBe(
      `hook turn-failed | ${JSON.stringify({ error: "error", error_details: error })}`,
    );
  });

  test("an event Pi sends in another shape still ends the turn", async () => {
    const { emit } = fakePi();
    await emit("agent_end", { messages: "none" });
    await emit("agent_settled", null);
    expect(hooks()).toBe('hook turn-ended | {"last_assistant_message":""}');
  });

  test("without sc on the PATH, Pi goes on", async () => {
    process.env.PATH = "/nowhere";
    const { emit } = fakePi();
    await emit("input", { text: "hi", source: "interactive" });
    await emit("agent_settled", {});
    expect(hooks()).toBe("");
  });

  test("shows the ready mark while idle with nothing typed, and a busy line counting seconds", async () => {
    const { emit } = fakePi();
    const { ctx, state, widgets } = fakeContext();
    await emit("session_start", { reason: "startup" }, ctx);
    expect(widgets.at(-1)).toEqual([readyMark]);
    // A draft hides the mark, so nothing typed in lands after it.
    state.typed = "half a";
    await Bun.sleep(400);
    expect(widgets.at(-1)).toBeUndefined();
    state.typed = "";
    state.idle = false;
    await Bun.sleep(1400);
    expect(widgets.at(-1)).toEqual([`${busyMark} 1s`]);
    expect(widgets).toContainEqual([`${busyMark} 0s`]);
    state.idle = true;
    await Bun.sleep(400);
    expect(widgets.at(-1)).toEqual([readyMark]);
    await emit("session_shutdown");
    const seen = widgets.length;
    state.idle = false;
    await Bun.sleep(400);
    expect(widgets.length).toBe(seen);
  });

  test("draws no marks in print mode, which has no screen", async () => {
    const { emit } = fakePi();
    const { ctx, widgets } = fakeContext({ hasUI: false });
    await emit("session_start", {}, ctx);
    await Bun.sleep(300);
    expect(widgets).toEqual([]);
  });
});

describe("the extension in a review", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } } };
  // The review's mark, as Skelcrew hands it to the extension for the review in this folder.
  const mark = () => z.string().parse(pi.review({ home, folder: home }).env.SKELCREW_PI_ERROR_MARK);
  const review = () => {
    writeFileSync(join(home, "schema.json"), JSON.stringify(schema));
    return fakePi({ SKELCREW_PI_REVIEW: home, SKELCREW_PI_ERROR_MARK: mark() });
  };

  test("gives the reviewer a verdict tool held to the shape, whose answer Skelcrew reads", async () => {
    const { tools } = review();
    const tool = tools.find((t) => t.name === verdictTool);
    expect(tool?.parameters).toEqual(schema);
    const given = { verdict: "approve", body: "Looks right.", findings: [] };
    await tool?.execute("call-1", given);
    expect(pi.answer(home)).toEqual(given);
  });

  test("an answer it never gave is no answer", () => {
    review();
    expect(() => pi.answer(home)).toThrow("it gave no answer");
  });

  test("runs no hooks, and prints Pi's error on a line Skelcrew takes as the only error", async () => {
    fakeSc();
    const { emit } = review();
    const printed: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array) => printed.push(String(chunk)) > 0;
    try {
      await emit("input", { text: "review this", source: "interactive" });
      const error = '429: {"message":"Rate limited.\\nSlow down."}';
      await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: error }));
      await emit("agent_settled", { aborted: false });
      await emit(
        "agent_end",
        answer({ content: [], stopReason: "error", errorMessage: "401: sk-proj-abcdefghijkl" }),
      );
      await emit("agent_settled", { aborted: false });
    } finally {
      process.stderr.write = write;
    }
    expect(pi.failure("", printed.at(-1) ?? "", home)).toBe("401: [key]");
    printed.pop();
    expect(hooks()).toBe("");
    // Pi prints a warning and the commands' own lines around it, and an error a test logged.
    const err = `Warning: tmux extended-keys is off\nERROR: rate limit in a test\n${printed.join("")}429: {"message":"Rate limited."}\nSlow down.\n`;
    expect(pi.failure("", err, home)).toBe('429: {"message":"Rate limited.\\nSlow down."}');
    expect(pi.failure("", "Warning: something\nERROR: rate limit in a test\n", home)).toBeNull();
    // The line without the review's mark, as a command could print it, is never Pi's error.
    const forged = "skelcrew: Pi failed: 429: slow down\nskelcrew: Pi failed abc: 429: slow down\n";
    expect(pi.failure("", forged, home)).toBeNull();
    // Nor is the mark of another review.
    expect(pi.failure("", printed.join(""), join(home, "other"))).toBeNull();
  });

  test("takes the mark out of the environment as it loads, before any command runs", () => {
    review();
    expect(process.env.SKELCREW_PI_ERROR_MARK).toBeUndefined();
  });
});

// Skelcrew reads the screen by the marks the extension draws, so the two must agree.
test("Skelcrew reads the marks the extension draws", () => {
  expect(pi.marks).toEqual({ busy: busyMark, prompt: readyMark });
});

// Captured from Pi 1.6.0 in tmux, with Skelcrew's extension loaded.
const screen = (name: string) => readFileSync(join(import.meta.dir, "screens", name), "utf8");
const lines = (text: string) => text.split("\n").map((line) => line.trim());

test("Skelcrew sees Pi at work while its line counts, and ready only at its mark with nothing typed", () => {
  const busy = screen("pi-busy.txt");
  const later = busy.replace(`${busyMark} 2s`, `${busyMark} 3s`);
  expect(quietSince(busy, later, pi.marks)).toBe(false);
  // Pi's own busy line reads Working, which Skelcrew doesn't go by.
  expect(quietSince(undefined, screen("pi-idle.txt"), pi.marks)).toBe(true);
  expect(lines(screen("pi-idle.txt"))).toContain(pi.marks.prompt);
  for (const name of ["pi-busy.txt", "pi-draft.txt"])
    expect(lines(screen(name))).not.toContain(pi.marks.prompt);
});

describe("usage limits", () => {
  const now = new Date(2026, 10, 22, 9, 0).getTime();

  test("a 429 or an exceeded quota is a limit, resetting when it says it will", () => {
    const at = pi.usageLimit('429: {"message":"Too many requests. Try again at 3:15 PM."}', now);
    expect(at).toEqual({ reset: new Date(2026, 10, 22, 15, 15).getTime() });
    const resets = pi.usageLimit("You exceeded your quota for the day, it resets at 5pm", now);
    expect(resets).toEqual({ reset: new Date(2026, 10, 22, 17, 0).getTime() });
    expect(pi.usageLimit("RESOURCE_EXHAUSTED: You exceeded your current quota", now)).toEqual({
      reset: null,
    });
  });

  test("an error that only mentions a quota, or any other error, is no limit", () => {
    for (const error of [
      '403: {"message":"quota project not set"}',
      "Your quota is shown at https://example.com",
      "500: internal error at 4291 requests",
      "500: request 429 failed",
      "404: no resource 429: gone",
      "fetch failed",
    ])
      expect(pi.usageLimit(error, now)).toBeNull();
  });

  test("a reset time comes only from resets at or try again at", () => {
    // "reset" alone names no time, though a clock follows it.
    const said = "429: connection reset by peer at 3pm";
    expect(pi.usageLimit(said, now)).toEqual({ reset: null });
  });

  // The extension tells a builder's limit, and Skelcrew a reviewer's, by the same rule.
  test("the extension and Skelcrew count the same errors as limits", () => {
    for (const error of [
      "429: slow down",
      "500: request 429 failed",
      "You exceeded your current quota",
      "quota project not set",
      "4291 requests",
      "fetch failed",
    ])
      expect(pi.usageLimit(error, now) !== null).toBe(isUsageLimit(error));
  });
});

describe("starting a lead or a builder", () => {
  const folder = () => join(data(), "threads", "app-12");
  const agentFolder = () => join(data(), "pi-sessions", "app-12");
  const env = () => ({
    HOME: home,
    PATH: "/usr/bin:/bin",
    GEMINI_API_KEY: "gemini-secret",
    OPENROUTER_API_KEY: "openrouter-secret",
    GH_TOKEN: "github-secret",
    COPILOT_GITHUB_TOKEN: "copilot-secret",
  });
  const start = (more: { resume?: string; sessionId?: string; model?: string } = {}) =>
    pi.start({
      name: "app-12",
      socket: join(home, "run", "app-12.sock"),
      thread: folder(),
      system: "Be a builder.",
      prompt: "--from: fix it",
      env: env(),
      ...(more.resume ? {} : { sessionId: "4b7d6f0e-0000-4000-8000-000000000001" }),
      ...more,
    });
  const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  test("runs Pi with Skelcrew's extension alone, its session, its instructions and its first message", async () => {
    const { argv, env: given } = await start({ model: "google/gemini-4-argon" });
    const command = argv.slice(argv.lastIndexOf("--", argv.indexOf("pi")) + 1);
    expect(command.slice(0, 5)).toEqual([
      "pi",
      "--no-extensions",
      "--extension",
      join(agentFolder(), "skelcrew.ts"),
      "--no-approve",
    ]);
    expect(after(command, "--session-dir")).toBe(join(agentFolder(), "sessions"));
    expect(after(command, "--session-id")).toBe("4b7d6f0e-0000-4000-8000-000000000001");
    expect(after(command, "--model")).toBe("google/gemini-4-argon");
    expect(command.slice(-2)).toEqual(["--", "--from: fix it"]);
    expect(readFileSync(after(command, "--append-system-prompt") ?? "", "utf8")).toBe(
      "Be a builder.",
    );
    // The extension Pi loads is the one this test drives.
    const source = await Bun.file(
      join(import.meta.dir, "..", "src", "agents", "pi-extension.ts"),
    ).text();
    expect(readFileSync(join(agentFolder(), "skelcrew.ts"), "utf8")).toBe(source);
    expect(given.PI_CODING_AGENT_DIR).toBe(agentFolder());
  });

  test("gives each session a copy of Skelcrew's own models.json, and none once it is gone", async () => {
    mkdirSync(join(data(), "pi"), { recursive: true });
    const models = '{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1"}}}';
    writeFileSync(join(data(), "pi", "models.json"), models);
    await start();
    const copy = join(agentFolder(), "models.json");
    expect(readFileSync(copy, "utf8")).toBe(models);
    rmSync(join(data(), "pi", "models.json"));
    await start();
    expect(existsSync(copy)).toBe(false);
  });

  test("with no model named, Pi picks its own", async () => {
    const { argv } = await start();
    expect(argv).not.toContain("--model");
  });

  test("brings a conversation back by its ID, with no first message", async () => {
    const { argv } = await start({ resume: "4b7d6f0e-0000-4000-8000-000000000001" });
    expect(after(argv, "--session-id")).toBe("4b7d6f0e-0000-4000-8000-000000000001");
    expect(argv).not.toContain("--from: fix it");
  });

  test("lets the providers' API keys in, but never a GitHub token, and never on the command line", async () => {
    const { argv, env: given } = await start();
    expect(given.GEMINI_API_KEY).toBe("gemini-secret");
    expect(given.OPENROUTER_API_KEY).toBe("openrouter-secret");
    expect(given.GH_TOKEN).toBeUndefined();
    expect(given.COPILOT_GITHUB_TOKEN).toBeUndefined();
    for (const secret of ["gemini-secret", "openrouter-secret", "github-secret", "copilot-secret"])
      expect(argv.join(" ")).not.toContain(secret);
  });

  test("every session links to one shared login, which the first run's login moves into", async () => {
    mkdirSync(join(data(), "pi"), { recursive: true });
    writeFileSync(join(data(), "pi", "auth.json"), '{"google":{"type":"api_key","key":"k"}}');
    const { argv } = await start();
    expect(readFileSync(login(), "utf8")).toContain('"google"');
    for (const folder of [join(data(), "pi"), agentFolder()])
      expect(readlinkSync(join(folder, "auth.json"))).toBe(login());
    // The login folder is the only one of Skelcrew's that the session can write besides its own.
    expect(argv.join(" ")).toContain(
      `--bind ${join(data(), "pi-login")} ${join(data(), "pi-login")}`,
    );
    // A copy the agent made in its own folder is never taken for the login.
    rmSync(join(agentFolder(), "auth.json"));
    writeFileSync(join(agentFolder(), "auth.json"), '{"mine":{}}');
    await start();
    expect(readlinkSync(join(agentFolder(), "auth.json"))).toBe(login());
    expect(readFileSync(login(), "utf8")).not.toContain("mine");
  });

  test("a link an agent left for the shared login is removed, never written through", async () => {
    await start();
    const yours = join(home, "yours");
    writeFileSync(yours, "keep\n");
    rmSync(login(), { force: true });
    Bun.spawnSync(["ln", "-s", yours, login()]);
    await start();
    expect(lstatSync(login(), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(yours, "utf8")).toBe("keep\n");
  });

  test("refuses a session that is both new and brought back", async () => {
    await expect(
      pi.start({
        name: "app-12",
        socket: "s",
        thread: folder(),
        sessionId: "a1",
        resume: "a1",
        env: env(),
      }),
    ).rejects.toThrow("both new and resumed");
  });
});

describe("a review", () => {
  test("runs Pi once in print mode on the shared login, its agent folder in the review's", () => {
    const folder = join(home, "review");
    mkdirSync(folder);
    const launch = pi.review({ home, folder, model: "openrouter/some-model" });
    expect(launch.command).toEqual([
      "pi",
      "--no-extensions",
      "--extension",
      join(folder, "pi", "skelcrew.ts"),
      "--no-approve",
      "--no-session",
      "--print",
      "--append-system-prompt",
      expect.stringContaining(verdictTool),
      "--model",
      "openrouter/some-model",
    ]);
    expect(launch.env).toEqual({
      PI_CODING_AGENT_DIR: join(folder, "pi"),
      PI_SKIP_VERSION_CHECK: "1",
      SKELCREW_PI_REVIEW: folder,
      SKELCREW_PI_ERROR_MARK: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Each review gets a mark of its own.
    const other = join(home, "other");
    mkdirSync(other);
    expect(pi.review({ home, folder: other }).env.SKELCREW_PI_ERROR_MARK).not.toBe(
      launch.env.SKELCREW_PI_ERROR_MARK,
    );
    expect(launch.mounts).toEqual(["--bind", join(data(), "pi-login"), join(data(), "pi-login")]);
    expect(readlinkSync(join(folder, "pi", "auth.json"))).toBe(login());
  });
});

test("Pi has a login once a provider is saved or a key it reads is set", () => {
  expect(piLoggedIn(home, {})).toBe(false);
  mkdirSync(join(data(), "pi-login"), { recursive: true });
  writeFileSync(login(), "{}");
  expect(piLoggedIn(home, {})).toBe(false);
  expect(piLoggedIn(home, { OPENROUTER_API_KEY: "k" })).toBe(true);
  writeFileSync(login(), '{"anthropic":{"type":"oauth"}}');
  expect(piLoggedIn(home, {})).toBe(true);
});

// Runs `code` in a Bun of its own under the test's home, as the Pi module finds Skelcrew's
// folders by the home Bun started with, and returns what it printed.
function underHome(code: string): string {
  const module = join(import.meta.dir, "..", "src", "agents", "pi.ts");
  const run = Bun.spawnSync(["bun", "-e", `import { pi } from "${module}";\n${code}`], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

test("finds a conversation Pi saved by its session ID, and none for a session nobody talked to", () => {
  const sessions = join(data(), "pi-sessions", "app-12", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "2026-11-22T06-39-37-745Z_s-1.jsonl"), "{}\n");
  mkdirSync(join(sessions, "2026-11-22T06-40-00-000Z_s-2.jsonl"));
  const look = (id: string) =>
    underHome(
      `console.log(JSON.stringify([pi.saved("app-12", "/x", "${id}"), pi.conversation("app-12", "/x", "${id}")]))`,
    );
  expect(JSON.parse(look("s-1"))).toEqual([
    "s-1",
    join(sessions, "2026-11-22T06-39-37-745Z_s-1.jsonl"),
  ]);
  // A folder named like one is no conversation.
  expect(JSON.parse(look("s-2"))).toEqual([null, null]);
  expect(JSON.parse(look("s-3"))).toEqual([null, null]);
});

test("reads a builder's tokens and step from Pi's conversation file", () => {
  const line = (message: object) => JSON.stringify({ type: "message", message });
  const usage = (input: number, output: number) => ({
    input,
    output,
    cacheRead: 900,
    cacheWrite: 10,
  });
  const call = (name: string, args: object) => ({
    type: "toolCall",
    id: "c",
    name,
    arguments: args,
  });
  const lines = [
    line({ role: "user", content: "go" }),
    line({ role: "assistant", usage: usage(100, 20), content: [call("read", { path: "a.ts" })] }),
    "not json",
    line({
      role: "assistant",
      usage: usage(5, 1),
      content: [call("edit", { path: "src/rows.ts" })],
    }),
  ];
  const read = pi.progress(lines, { step: null, tokens: null, plan: null, last: "" });
  expect(read).toEqual({
    step: "Editing rows.ts",
    tokens: 100 + 10 + 20 + 5 + 10 + 1,
    plan: null,
    last: "",
  });
  // A command has no step.
  const bash = line({ role: "assistant", content: [call("bash", { command: "cd x && make" })] });
  expect(pi.progress([bash], read).step).toBeNull();
});
