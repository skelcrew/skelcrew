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
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { pi, piLoggedIn, renewLogins } from "../src/agents/pi.ts";
import skelcrew, {
  busyMark,
  failureOf,
  limitWords,
  readyMark,
  verdictTool,
} from "../src/agents/pi-extension.ts";
import { quietSince } from "../src/agents/transport.ts";

let home = "";
// What an agent says when its sign-in expired before Skelcrew could renew it.
const expired =
  "the sign-in expired and Skelcrew couldn't renew it yet: it keeps trying, or sign Skelcrew in to Pi again";
const data = () => join(home, ".local", "share", "skelcrew");
// Saves Skelcrew's Pi login, as pi auth login does.
function saveLogin(logins: object): void {
  mkdirSync(join(data(), "pi"), { recursive: true });
  writeFileSync(join(data(), "pi", "auth.json"), JSON.stringify(logins));
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-pi-test-")));
  mkdirSync(join(home, "bin"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// What Pi gives a handler besides its event: whether it has a screen, whether it is idle, and
// what is typed at its input. Each widget set is kept.
function fakeContext(given: { idle?: boolean; typed?: string; hasUI?: boolean } = {}) {
  const state = { idle: given.idle ?? true, typed: given.typed ?? "" };
  const widgets: (string[] | undefined)[] = [];
  const ctx = {
    hasUI: given.hasUI ?? true,
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

// The errors Pi 1.6.0 reported for providers' own answers, as their docs give them, on each of
// Pi's provider APIs: a fake server answered with each body, and Pi's errorMessage was kept. On
// Google's API Pi passes the body on alone, so only Google's own bodies, which always name their
// code, are there.
const ProviderError = z.object({
  api: z.string(),
  body: z.string(),
  error: z.string(),
  limit: z.boolean(),
});
const providerErrors = z
  .array(ProviderError)
  .parse(JSON.parse(readFileSync(join(import.meta.dir, "pi-errors.json"), "utf8")));
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

  // What a turn that ended on `error` sends Skelcrew, as the hook's input.
  const failedTurn = async (error: string) => {
    rmSync(hooksFile(), { force: true });
    const { emit } = fakePi();
    await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: error }));
    await emit("agent_settled", { aborted: false });
    return hooks();
  };
  const sent = (kind: string, message: string) =>
    `hook turn-failed | ${JSON.stringify({ error: kind, error_details: message })}`;

  test("a usage limit ends the turn as a rate limit, after Pi's retries, in Skelcrew's words", async () => {
    const { emit } = fakePi();
    const limit = '429: {"message":"You exceeded your current quota. Try again at 3:15 PM."}';
    // Pi tries three times, and each try ends a run.
    for (let i = 0; i < 3; i++)
      await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: limit }));
    await emit("agent_settled", { aborted: false });
    expect(hooks()).toBe(sent("rate_limit", "rate limited (429), resets at 3:15 PM"));
  });

  test("a provider error with a key in it never reaches Skelcrew: only its kind, its status and Skelcrew's words", async () => {
    const key = "sk-live-Abc123SECRETkeyZ";
    const shortKey = "qwerty";
    const cases: [string, string, string][] = [
      [
        `429: {"message":"Key ${key} is over its quota. Try again at 3:15 PM."}`,
        "rate_limit",
        "rate limited (429), resets at 3:15 PM",
      ],
      [
        `401 {"error":{"message":"Invalid key: ${shortKey}"}}`,
        "auth",
        "auth failed (401): check Pi's login or key",
      ],
      [
        `{"error":{"code":403,"message":"key ${key} has no quota project"}}`,
        "auth",
        "auth failed (403): check Pi's login or key",
      ],
      [
        `openrouter API error (500): {"message":"failed for ${key}"}`,
        "provider",
        "the provider failed (500)",
      ],
      [
        `request to https://example.com/?key=${key} failed`,
        "network",
        "the request failed with no HTTP status, such as offline",
      ],
    ];
    for (const [error, kind, message] of cases) {
      const said = await failedTurn(error);
      expect(said).toBe(sent(kind, message));
      expect(said).not.toContain(key);
      expect(said).not.toContain(shortKey);
    }
  });

  test("every error Pi reported for a provider reaches Skelcrew as its kind and status alone", async () => {
    for (const { api, body, error, limit } of providerErrors) {
      const said = await failedTurn(error);
      const kind = limit ? "rate_limit" : "auth or provider";
      const seen = said.includes('"error":"rate_limit"') ? "rate_limit" : "auth or provider";
      expect({ api, body, kind: seen }).toEqual({ api, body, kind });
      // No word of the provider's own reaches Skelcrew.
      expect(said).not.toContain("message");
      expect(said).not.toContain("quota");
    }
  });

  test("a reset comes only from the clock right after resets at or try again at", async () => {
    expect(await failedTurn('429: {"message":"Your limit resets at 14:00."}')).toBe(
      sent("rate_limit", "rate limited (429), resets at 14:00"),
    );
    const at = '429 {"error":{"message":"Try again at Dec 31st, 2099 11:59 PM."}}';
    expect(await failedTurn(at)).toBe(
      sent("rate_limit", "rate limited (429), resets at Dec 31st, 2099 11:59 PM"),
    );
    for (const error of [
      "429: connection reset by peer at 3pm",
      "429: resets at an unknown time; contact support at 5pm",
      "429: try again at sk-live-abc 12 3pm",
    ])
      expect(await failedTurn(error)).toBe(sent("rate_limit", "rate limited (429)"));
  });

  test("a ChatGPT sign-in's usage limit, which has no status, is a rate limit, with its minutes to the reset", async () => {
    const limit = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
    expect(await failedTurn(limit)).toBe(
      sent("rate_limit", "rate limited by ChatGPT's usage limit, resets in ~42 min"),
    );
    expect(await failedTurn("You have hit your ChatGPT usage limit (pro plan).")).toBe(
      sent("rate_limit", "rate limited by ChatGPT's usage limit"),
    );
  });

  test("OpenAI's insufficient_quota is no limit to wait out, as your credit ran out", async () => {
    const outOfCredit = "out of credit (429): check the provider's plan and billing";
    for (const error of [
      '429: {"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}',
      '429 {"error":{"message":"You exceeded your current quota.","code":"insufficient_quota"}}',
      'openai API error (429): {"message":"over","type":"insufficient_quota"}',
    ])
      expect(await failedTurn(error)).toBe(sent("billing", outOfCredit));
  });

  test("a sign-in that expired before Skelcrew renewed it is a failed login, in Skelcrew's words", async () => {
    for (const error of [
      'OAuth refresh failed for anthropic: Anthropic token refresh request failed. body={"error":{"message":"Invalid request format"}}',
      "OAuth refresh failed for anthropic: fetch failed",
      "Credential store modify failed for anthropic",
    ])
      expect(await failedTurn(error)).toBe(sent("auth", expired));
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
  const mark = async () =>
    z.string().parse((await pi.review({ home, folder: home })).env.SKELCREW_PI_ERROR_MARK);
  const review = async () => {
    writeFileSync(join(home, "schema.json"), JSON.stringify(schema));
    return fakePi({ SKELCREW_PI_REVIEW: home, SKELCREW_PI_ERROR_MARK: await mark() });
  };

  test("gives the reviewer a verdict tool held to the shape, whose answer Skelcrew reads", async () => {
    const { tools } = await review();
    const tool = tools.find((t) => t.name === verdictTool);
    expect(tool?.parameters).toEqual(schema);
    const given = { verdict: "approve", body: "Looks right.", findings: [] };
    await tool?.execute("call-1", given);
    expect(pi.answer(home)).toEqual(given);
  });

  test("an answer it never gave is no answer", async () => {
    await review();
    expect(() => pi.answer(home)).toThrow("it gave no answer");
  });

  test("runs no hooks, and prints Skelcrew's words for Pi's error on a line with the review's mark", async () => {
    fakeSc();
    const { emit } = await review();
    const printed: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array) => printed.push(String(chunk)) > 0;
    try {
      await emit("input", { text: "review this", source: "interactive" });
      await emit("agent_start");
      await emit("agent_start");
      const error = '429: {"message":"Key sk-live-Abc123SECRETkeyZ is rate limited."}';
      await emit("agent_end", answer({ content: [], stopReason: "error", errorMessage: error }));
      await emit("agent_settled", { aborted: false });
    } finally {
      process.stderr.write = write;
    }
    expect(hooks()).toBe("");
    expect(printed.join("")).not.toContain("sk-live");
    // Pi says it is at work once, however many runs it starts.
    expect(printed.filter((line) => line.includes("Pi at work"))).toHaveLength(1);
    const [atWork = "", line = ""] = printed;
    expect(pi.failure("", `Warning: tmux extended-keys is off\n${atWork}${line}`, home)).toBe(
      "rate limited (429)",
    );
    // Once Pi is at work, a line its commands print is never taken for its error.
    expect(pi.failure("", `${atWork}ERROR: rate limit in a test\n`, home)).toBeNull();
    // Nor is the line without the review's mark, as a command could print it.
    const forged =
      "skelcrew: Pi failed: rate limited (429)\nskelcrew: Pi failed abc: rate limited (429)\n";
    expect(pi.failure("", `${atWork}${forged}`, home)).toBeNull();
  });

  // Pi 1.6.0 prints this and exits with 1 for a model it doesn't know, before the extension's
  // events.
  test("before Pi is at work, Skelcrew's own words say Pi failed to start, never Pi's", () => {
    const unknown = 'Error: Model "nosuch/m" not found. Use --list-models to see available models.';
    const said = pi.failure("", `Warning: tmux extended-keys is off\n${unknown}\n`, home);
    expect(said).toBe(
      "Pi failed to start, such as on a model it doesn't know: run pi by hand to see why",
    );
    expect(pi.failure("", "Error: key sk-live-Abc123SECRETkeyZ refused\n", home)).toBe(said);
    // A Pi that printed nothing at all didn't fail to start: it gave no answer.
    expect(pi.failure("", "\n", home)).toBeNull();
  });

  test("takes the mark out of the environment as it loads, before any command runs", async () => {
    await review();
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

  test("Skelcrew reads a limit, and when it resets, from the extension's words alone", () => {
    expect(pi.usageLimit(`${limitWords} by ChatGPT's usage limit, resets in ~42 min`, now)).toEqual(
      {
        reset: now + 42 * 60_000,
      },
    );
    expect(pi.usageLimit(`${limitWords} (429), resets at 3:15 PM`, now)).toEqual({
      reset: new Date(2026, 10, 22, 15, 15).getTime(),
    });
    expect(pi.usageLimit(`${limitWords} (429), resets at Dec 31st, 2099 11:59 PM`, now)).toEqual({
      reset: new Date(2099, 11, 31, 23, 59).getTime(),
    });
    // A 24-hour time has no AM or PM.
    expect(pi.usageLimit(`${limitWords} (429), resets at 14:00`, now)).toEqual({
      reset: new Date(2026, 10, 22, 14, 0).getTime(),
    });
    expect(pi.usageLimit(`${limitWords} (429), resets at Dec 31st, 2099 23:59`, now)).toEqual({
      reset: new Date(2099, 11, 31, 23, 59).getTime(),
    });
    expect(pi.usageLimit(`${limitWords} (429), resets at 25:00`, now)).toEqual({ reset: null });
    expect(pi.usageLimit(limitWords, now)).toEqual({ reset: null });
    for (const error of [
      "auth failed (401): check Pi's login or key",
      "the provider failed (500)",
      "the request failed with no HTTP status, such as offline",
      "out of credit (429): check the provider's plan and billing",
      expired,
      "Pi failed to start, such as on a model it doesn't know: run pi by hand to see why",
      '429: {"message":"raw text from a provider"}',
    ])
      expect(pi.usageLimit(error, now)).toBeNull();
  });

  test("each provider error the extension counts as a limit, Skelcrew does too", () => {
    for (const { error, limit } of providerErrors)
      expect(pi.usageLimit(failureOf(error).message, now) !== null).toBe(limit);
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
    CLOUDFLARE_API_KEY: "cf-secret",
    CLOUDFLARE_ACCOUNT_ID: "cf-account",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
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

  test("lets no key or token of your environment in, and none on the command line", async () => {
    const { argv, env: given } = await start();
    for (const key of Object.keys(env()))
      if (key !== "HOME" && key !== "PATH") expect(given[key]).toBeUndefined();
    for (const secret of ["gemini-secret", "openrouter-secret", "github-secret", "copilot-secret"])
      expect(argv.join(" ")).not.toContain(secret);
  });

  test("gives each session its own copy of Skelcrew's login, which no sandbox sees", async () => {
    saveLogin({ google: { type: "api_key", key: "k" } });
    const { argv } = await start();
    expect(JSON.parse(readFileSync(join(agentFolder(), "auth.json"), "utf8"))).toEqual({
      google: { type: "api_key", key: "k" },
    });
    expect(lstatSync(join(agentFolder(), "auth.json")).isFile()).toBe(true);
    expect(argv).not.toContain(join(data(), "pi"));
    expect(argv).not.toContain(join(data(), "pi", "auth.json"));
  });

  test("one agent's write to its login reaches no other agent, nor Skelcrew's login", async () => {
    saveLogin({ google: { type: "api_key", key: "k" } });
    await start();
    const other = await pi.start({
      name: "app-13",
      socket: join(home, "run", "app-13.sock"),
      thread: join(data(), "threads", "app-13"),
      sessionId: "4b7d6f0e-0000-4000-8000-000000000002",
      env: env(),
    });
    const planted = '{"google":{"type":"api_key","key":"!touch /tmp/planted"}}';
    writeFileSync(join(agentFolder(), "auth.json"), planted);
    const otherLogin = join(data(), "pi-sessions", "app-13", "auth.json");
    expect(readFileSync(otherLogin, "utf8")).not.toContain("planted");
    expect(readFileSync(join(data(), "pi", "auth.json"), "utf8")).not.toContain("planted");
    // Neither sandbox can write where the other's login is.
    expect(other.argv.join(" ")).not.toContain(agentFolder());
    // The agent's change lasts only until its session starts again.
    await start();
    expect(readFileSync(join(agentFolder(), "auth.json"), "utf8")).not.toContain("planted");
  });

  test("a link an agent left for its login is removed, never written through", async () => {
    saveLogin({ google: { type: "api_key", key: "k" } });
    await start();
    const yours = join(home, "yours");
    writeFileSync(yours, "keep\n");
    rmSync(join(agentFolder(), "auth.json"));
    Bun.spawnSync(["ln", "-s", yours, join(agentFolder(), "auth.json")]);
    await start();
    expect(lstatSync(join(agentFolder(), "auth.json")).isFile()).toBe(true);
    expect(readFileSync(yours, "utf8")).toBe("keep\n");
  });

  test("a copied sign-in has no refresh token, and Skelcrew renews one that expires soon first", async () => {
    const later = Date.now() + 3 * 24 * 60 * 60 * 1000;
    saveLogin({
      anthropic: {
        type: "oauth",
        access: "old",
        refresh: "keep-out",
        expires: Date.now() + 60_000,
      },
      "openai-codex": { type: "oauth", access: "fine", refresh: "keep-out-too", expires: later },
    });
    // A fake pi renews the sign-in in Skelcrew's login, as pi auth print-bearer-token does.
    const renewed = { type: "oauth", access: "new", refresh: "rotated", expires: later };
    writeFileSync(
      join(home, "bin", "pi"),
      `#!/bin/sh\necho "$*" >> "${join(home, "renewals")}"\n` +
        `printf '%s' '${JSON.stringify({ anthropic: renewed, "openai-codex": { type: "oauth", access: "fine", refresh: "keep-out-too", expires: later } })}' > "$PI_CODING_AGENT_DIR/auth.json"\n` +
        "echo the-token\n",
      { mode: 0o755 },
    );
    await pi.start({
      name: "app-12",
      socket: join(home, "run", "app-12.sock"),
      thread: folder(),
      sessionId: "4b7d6f0e-0000-4000-8000-000000000001",
      env: { ...env(), PATH: `${join(home, "bin")}:/usr/bin:/bin` },
    });
    // Only the sign-in that expires soon is renewed, outside the sandbox, in Skelcrew's login.
    expect(readFileSync(join(home, "renewals"), "utf8")).toBe(
      "auth print-bearer-token --provider anthropic --min-expiry 20m\n",
    );
    expect(JSON.parse(readFileSync(join(agentFolder(), "auth.json"), "utf8"))).toEqual({
      anthropic: { ...renewed, refresh: "" },
      "openai-codex": { type: "oauth", access: "fine", refresh: "", expires: later },
    });
  });

  // Puts a fake pi first on the path, which renews Skelcrew's sign-in to anthropic as `renewed`,
  // as pi auth print-bearer-token does, or fails while the file "failing" is there.
  const renewingPi = (renewed: object) => {
    writeFileSync(
      join(home, "bin", "pi"),
      `#!/bin/sh\necho "$*" >> "${join(home, "renewals")}"\n` +
        `[ -e "${join(home, "failing")}" ] && exit 1\n` +
        `printf '%s' '${JSON.stringify({ anthropic: renewed })}' > "$PI_CODING_AGENT_DIR/auth.json"\n`,
      { mode: 0o755 },
    );
    return `${join(home, "bin")}:/usr/bin:/bin`;
  };
  const signIn = (access: string, refresh: string, minutes: number) => ({
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + minutes * 60_000,
  });
  const copied = (file: string) => JSON.parse(readFileSync(file, "utf8"));

  test("a renewal reaches each running agent's copy, never with the refresh token", async () => {
    saveLogin({ anthropic: signIn("first", "r1", 60) });
    await start();
    const review = join(home, "review");
    mkdirSync(review);
    await pi.review({ home, folder: review });
    const copies = [join(agentFolder(), "auth.json"), join(review, "pi", "auth.json")];
    for (const copy of copies) expect(copied(copy).anthropic.access).toBe("first");
    // The sign-in nears its end while the builder and the review still run.
    saveLogin({ anthropic: signIn("first", "r1", 10) });
    const renewed = signIn("second", "r2", 8 * 60);
    await renewLogins(home, renewingPi(renewed));
    for (const copy of copies)
      expect(copied(copy)).toEqual({ anthropic: { ...renewed, refresh: "" } });
    expect(readFileSync(copies[0] ?? "", "utf8")).not.toContain("r2");
    expect(copied(join(data(), "pi", "auth.json")).anthropic.refresh).toBe("r2");
    // A copy that went, as its review ended, is never written again.
    rmSync(join(review, "pi"), { recursive: true });
    saveLogin({ anthropic: signIn("second", "r2", 10) });
    await renewLogins(home, renewingPi(signIn("third", "r3", 8 * 60)));
    expect(copied(copies[0] ?? "").anthropic).toMatchObject({ access: "third", refresh: "" });
    expect(existsSync(join(review, "pi"))).toBe(false);
  });

  test("a sign-in that doesn't end soon isn't renewed, and a key never is", async () => {
    saveLogin({ anthropic: signIn("first", "r1", 60), google: { type: "api_key", key: "k" } });
    await start();
    await renewLogins(home, renewingPi(signIn("second", "r2", 60)));
    expect(existsSync(join(home, "renewals"))).toBe(false);
    expect(copied(join(agentFolder(), "auth.json")).anthropic.access).toBe("first");
  });

  test("a failed renewal leaves each copy as it was, and the next one tries again", async () => {
    saveLogin({ anthropic: signIn("first", "r1", 10) });
    const renewed = signIn("second", "r2", 8 * 60);
    const path = renewingPi(renewed);
    writeFileSync(join(home, "failing"), "");
    await pi.start({
      name: "app-12",
      socket: join(home, "run", "app-12.sock"),
      thread: folder(),
      sessionId: "4b7d6f0e-0000-4000-8000-000000000001",
      env: { ...env(), PATH: path },
    });
    const copy = join(agentFolder(), "auth.json");
    expect(copied(copy).anthropic).toMatchObject({ access: "first", refresh: "" });
    await expect(renewLogins(home, path)).rejects.toThrow(
      "couldn't renew Pi's sign-in to anthropic",
    );
    expect(copied(copy).anthropic).toMatchObject({ access: "first", refresh: "" });
    rmSync(join(home, "failing"));
    await renewLogins(home, path);
    expect(copied(copy)).toEqual({ anthropic: { ...renewed, refresh: "" } });
    expect(readFileSync(join(home, "renewals"), "utf8").split("\n").length - 1).toBe(3);
  });

  test("a copy waits while Pi holds its lock on the login, so it never copies half a renewal", async () => {
    const login = join(data(), "pi", "auth.json");
    saveLogin({ anthropic: signIn("first", "r1", 60) });
    // Pi renews in place, inside its lock, as `pi auth print-bearer-token` does.
    mkdirSync(`${login}.lock`);
    writeFileSync(login, '{"anthropic":{"type":"oauth","acc');
    const started = start();
    await Bun.sleep(300);
    expect(existsSync(join(agentFolder(), "auth.json"))).toBe(false);
    const renewed = signIn("second", "r2", 8 * 60);
    writeFileSync(login, JSON.stringify({ anthropic: renewed }));
    rmSync(`${login}.lock`, { recursive: true });
    await started;
    expect(copied(join(agentFolder(), "auth.json"))).toEqual({
      anthropic: { ...renewed, refresh: "" },
    });
  });

  test("a lock a pi left as it died doesn't hold a copy back", async () => {
    const login = join(data(), "pi", "auth.json");
    saveLogin({ google: { type: "api_key", key: "k" } });
    mkdirSync(`${login}.lock`);
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(`${login}.lock`, minuteAgo, minuteAgo);
    await start();
    expect(copied(join(agentFolder(), "auth.json"))).toEqual({
      google: { type: "api_key", key: "k" },
    });
    expect(existsSync(`${login}.lock`)).toBe(false);
  });

  test("a login that can't be read stops the start, rather than start an agent with none", async () => {
    mkdirSync(join(data(), "pi"), { recursive: true });
    writeFileSync(join(data(), "pi", "auth.json"), '{"anthropic":');
    await expect(start()).rejects.toThrow("Skelcrew's Pi login can't be read");
  });

  test("a session gets no login when Skelcrew has none", async () => {
    await start();
    expect(existsSync(join(agentFolder(), "auth.json"))).toBe(false);
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
  test("runs Pi once in print mode on its own copy of the login, its agent folder in the review's", async () => {
    saveLogin({ openrouter: { type: "api_key", key: "k" } });
    const folder = join(home, "review");
    mkdirSync(folder);
    const launch = await pi.review({ home, folder, model: "openrouter/some-model" });
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
    expect((await pi.review({ home, folder: other })).env.SKELCREW_PI_ERROR_MARK).not.toBe(
      launch.env.SKELCREW_PI_ERROR_MARK,
    );
    expect(launch.mounts).toEqual([]);
    expect(JSON.parse(readFileSync(join(folder, "pi", "auth.json"), "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "k" },
    });
  });
});

test("a provider of your own in Skelcrew's models.json is a login, as Pi needs no other", () => {
  mkdirSync(join(data(), "pi"), { recursive: true });
  const models = join(data(), "pi", "models.json");
  writeFileSync(models, '{"providers":{}}');
  expect(piLoggedIn(home)).toBe(false);
  writeFileSync(
    models,
    '{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","apiKey":"local"}}}',
  );
  expect(piLoggedIn(home)).toBe(true);
});

test("Pi has a login once a provider is saved, never for a key in the shell alone", () => {
  expect(piLoggedIn(home)).toBe(false);
  saveLogin({});
  expect(piLoggedIn(home)).toBe(false);
  saveLogin({ anthropic: { type: "oauth" } });
  expect(piLoggedIn(home)).toBe(true);
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
