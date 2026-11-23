// Pi as a harness: how a lead or builder starts and finds its conversation, what its screens
// show, how a review answers and fails, and each agent's own copy of Skelcrew's Pi login, which a
// fake pi renews. The screens were captured from Pi 1.6.0 against a fake model server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepLogins } from "../src/agents/harness.ts";
import { sessionLogin } from "../src/agents/login-copies.ts";
import { pi } from "../src/agents/pi.ts";
import { startedWord } from "../src/agents/pi-extension.ts";
import { copyPiLogin, piHome, renewPiLogin } from "../src/agents/pi-login.ts";
import { agentOutput } from "../src/list/live.ts";
import { dataDir } from "../src/paths.ts";

let home = "";
const path = process.env.PATH;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-pi-test-")));
});
afterEach(() => {
  process.env.PATH = path;
  rmSync(home, { recursive: true, force: true });
});

const data = () => join(home, ".local", "share", "skelcrew");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const screen = (name: string) => Bun.file(join(import.meta.dir, "screens", name)).text();
const bottom = (text: string) =>
  Bun.stripANSI(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .at(-1)
    ?.trim();

// Saves Skelcrew's own Pi login as pi auth login does: a sign-in that ends in `inMs`, and a key.
function saveLogin(inMs: number, access = "access-1"): void {
  mkdirSync(piHome(home), { recursive: true });
  const login = {
    anthropic: { type: "oauth", access, refresh: "refresh-1", expires: Date.now() + inMs },
    openrouter: { type: "api_key", key: "sk-or-1" },
  };
  writeFileSync(join(piHome(home), "auth.json"), JSON.stringify(login));
}

// Puts a fake pi on the PATH, which logs how it was run and renews the sign-in as pi does, by
// writing the login anew with a new access and refresh token.
function fakePi(): string {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const renewed = join(home, "renewed.json");
  const login = {
    anthropic: {
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: Date.now() + 3_600_000,
    },
  };
  writeFileSync(renewed, JSON.stringify(login));
  const script = `#!/bin/sh\necho "$*" >> "${home}/pi.log"\ncp "${renewed}" "$PI_CODING_AGENT_DIR/auth.json"\n`;
  writeFileSync(join(bin, "pi"), script);
  chmodSync(join(bin, "pi"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  return join(home, "pi.log");
}

test("Pi's input, rules and footer are cut, idle, typed into or at work", async () => {
  expect(bottom(agentOutput("pi", await screen("pi-idle.txt")))).toBe("Hello from the fake model.");
  expect(bottom(agentOutput("pi", await screen("pi-typed.txt")))).toBe(
    "Hello from the fake model.",
  );
  expect(bottom(agentOutput("pi", await screen("pi-busy.txt")))).toBe("please sleep");
  // Without the extension's line, the screen shows whole.
  const without = (await screen("pi-idle.txt")).replace("Skelcrew: ready", "");
  expect(agentOutput("pi", without)).toBe(without);
});

test("a lead or builder starts with Skelcrew's extension, its own folder and no provider's key", () => {
  const clone = join(home, "clone");
  const without = {
    name: "app-12",
    socket: join(home, "run", "app-12.sock"),
    thread: clone,
    sessionId: "11111111-2222-3333-4444-555555555555",
    env: { HOME: home, PATH: path, ANTHROPIC_API_KEY: "sk-ant-1" },
  };
  // With no login of Skelcrew's, Pi would have nothing to run on, as no key reaches it.
  expect(() => pi.start(without)).toThrow("run sc to sign in to Pi");
  saveLogin(3_600_000);
  const started = pi.start({
    name: "app-12",
    socket: join(home, "run", "app-12.sock"),
    model: "anthropic/claude-opus-5-5",
    thread: clone,
    prompt: "--from the issue",
    system: "Be a builder.",
    sessionId: "11111111-2222-3333-4444-555555555555",
    env: { HOME: home, PATH: path, ANTHROPIC_API_KEY: "sk-ant-1", OPENAI_API_KEY: "sk-1" },
  });
  const folder = join(data(), "pi-sessions", "app-12");
  const at = started.argv.indexOf("pi");
  expect(started.argv.slice(at)).toEqual([
    "pi",
    "--no-approve",
    "-e",
    join(folder, "skelcrew.ts"),
    "--session-dir",
    join(folder, "sessions"),
    "--session-id",
    "11111111-2222-3333-4444-555555555555",
    "--model",
    "anthropic/claude-opus-5-5",
    "--append-system-prompt",
    join(folder, "instructions.md"),
    "--",
    "--from the issue",
  ]);
  const source = readFileSync(join(import.meta.dir, "..", "src", "agents", "pi-extension.ts"));
  expect(readFileSync(join(folder, "skelcrew.ts"))).toEqual(source);
  expect(readFileSync(join(folder, "instructions.md"), "utf8")).toBe("Be a builder.");
  expect(started.env.PI_CODING_AGENT_DIR).toBe(folder);
  expect(started.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(started.env.OPENAI_API_KEY).toBeUndefined();
});

// Pi from npm runs on node, which can be installed under the home folder apart from Pi's own
// npm prefix, such as by a version manager. The sandbox hides the home folder, so it shows both.
test.skipIf(process.platform === "darwin")(
  "a lead or builder sees Node in its own folder, apart from Pi's",
  () => {
    const piBin = join(home, "npm", "bin");
    const nodeBin = join(home, "node", "bin");
    for (const [folder, name] of [
      [piBin, "pi"],
      [nodeBin, "node"],
    ] as const) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, name), "#!/bin/sh\n", { mode: 0o755 });
    }
    saveLogin(3_600_000);
    const started = pi.start({
      name: "app-12",
      socket: join(home, "run", "app-12.sock"),
      thread: join(home, "clone"),
      sessionId: "11111111-2222-3333-4444-555555555555",
      env: { HOME: home, PATH: `${piBin}:${nodeBin}:/usr/bin:/bin` },
    });
    const shown = (folder: string) =>
      started.argv.some((word, at) => word === "--ro-bind" && started.argv[at + 1] === folder);
    expect(shown(piBin)).toBe(true);
    expect(shown(nodeBin)).toBe(true);
  },
);

test("a session gets its own copy of the login as it starts, without refresh tokens", async () => {
  saveLogin(3_600_000);
  const started = pi.start({
    name: "app-12",
    socket: join(home, "run", "app-12.sock"),
    thread: join(home, "clone"),
    sessionId: "11111111-2222-3333-4444-555555555555",
    env: { HOME: home, PATH: path },
  });
  // The copy is removed as the session ends, outside the sandbox.
  expect(started.argv[0]).toBe("/bin/sh");
  const link = join(data(), "pi-sessions", "app-12", "auth.json");
  await started.launch(async () => "started");
  const copy = read(link);
  expect(copy.anthropic.access).toBe("access-1");
  expect(copy.anthropic.refresh).toBe("");
  expect(copy.openrouter.key).toBe("sk-or-1");
  expect(readlinkSync(link)).toStartWith(join(data(), "pi-logins", "app-12+"));
  // A start that fails leaves no copy behind.
  const again = pi.start({
    name: "app-12",
    socket: join(home, "run", "app-12.sock"),
    thread: join(home, "clone"),
    resume: "11111111-2222-3333-4444-555555555555",
    env: { HOME: home, PATH: path },
  });
  const failing = again.launch(async () => {
    throw new Error("the host failed");
  });
  expect(failing).rejects.toThrow("the host failed");
  await failing.catch(() => {});
  expect(existsSync(link)).toBe(false);
  expect(readdirSync(join(data(), "pi-logins"))).toEqual([]);
});

test("a conversation is found by its ID once Pi saved it, and gives the builder's progress", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  // Sessions are found in the run's own home, so the name is this test's alone.
  const name = `app-${crypto.randomUUID()}`;
  const folder = join(dataDir(), "pi-sessions", name);
  try {
    expect(pi.saved(name, "/clone", id)).toBeNull();
    mkdirSync(join(folder, "sessions"), { recursive: true });
    const file = join(folder, "sessions", `2026-11-22T19-01-17-901Z_${id}.jsonl`);
    writeFileSync(file, "");
    expect(pi.saved(name, "/clone", id)).toBe(id);
    expect(pi.conversation(name, "/clone", id)).toBe(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  const line = (
    content: object[],
    usage = { input: 100, output: 7, cacheRead: 500, cacheWrite: 20 },
  ) => JSON.stringify({ type: "message", message: { role: "assistant", content, usage } });
  const progress = pi.progress(
    [
      line([{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/a.ts" } }]),
      line([{ type: "toolCall", id: "2", name: "edit", arguments: { path: "src/api/limit.ts" } }]),
    ],
    { step: null, tokens: null, plan: null, last: "" },
  );
  expect(progress).toEqual({ step: "Editing limit.ts", tokens: 254, plan: null, last: "" });
});

test("a review's error is read after its mark, and Pi's own words never count", async () => {
  saveLogin(3_600_000);
  const folder = mkdtempSync(join(home, "review-"));
  const review = await pi.review({ home, folder, model: "openai/gpt-6" });
  const mark = review.env.SKELCREW_PI_MARK;
  expect(review.command).toContain("--no-approve");
  expect(read(join(folder, "pi", "auth.json")).anthropic.refresh).toBe("");
  const started = `${mark} ${startedWord}\n`;
  // Pi stopped before its extension said anything, such as on a model it doesn't know.
  const unknown = 'Error: Model "openai/gpt-6" not found.';
  expect(pi.failure("", unknown, folder)).toBe("Pi stopped before the review started");
  // A command in the review printed a line like the extension's, without the mark.
  const forged = `${started}usage limit reached (429)\n429: {"message":"sk-1"}`;
  expect(pi.failure("", forged, folder)).toBeNull();
  const limited = `${started}${mark} usage limit reached (429), resets at 3:15 PM\n429: {"message":"sk-1"}`;
  const error = pi.failure("", limited, folder) ?? "";
  expect(error).toBe("usage limit reached (429), resets at 3:15 PM");
  expect(pi.usageLimit(error, Date.now())?.reset).toBeNumber();
  expect(pi.usageLimit("the provider failed the request (500)", Date.now())).toBeNull();
});

test("Skelcrew renews a sign-in that ends within 20 minutes and writes it into every copy", async () => {
  const log = fakePi();
  saveLogin(3_600_000);
  const copy = sessionLogin(home, "pi", "app-12");
  await copyPiLogin(home, copy);
  // Not due yet.
  await renewPiLogin(home);
  expect(existsSync(log)).toBe(false);
  saveLogin(10 * 60_000);
  await renewPiLogin(home);
  expect(readFileSync(log, "utf8")).toBe(
    "auth print-bearer-token --provider anthropic --min-expiry 20m\n",
  );
  expect(read(join(copy, "auth.json")).anthropic).toMatchObject({
    access: "access-2",
    refresh: "",
  });
});

test("Skelcrew reads its login under Pi's lock, and takes over one a stopped pi left", async () => {
  saveLogin(3_600_000);
  const lock = `${join(piHome(home), "auth.json")}.lock`;
  mkdirSync(lock);
  let copied = false;
  const copying = copyPiLogin(home, join(home, "copy")).then(() => {
    copied = true;
  });
  await Bun.sleep(200);
  expect(copied).toBe(false);
  rmSync(lock, { recursive: true });
  await copying;
  expect(read(join(home, "copy", "auth.json")).anthropic.access).toBe("access-1");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  await copyPiLogin(home, join(home, "copy-2"));
  expect(existsSync(lock)).toBe(false);
});

test("the sweep removes the copy of each Pi session that ended", async () => {
  saveLogin(3_600_000);
  const ended = sessionLogin(home, "pi", "app-12");
  const running = sessionLogin(home, "pi", "app-13");
  await copyPiLogin(home, ended);
  await copyPiLogin(home, running);
  await keepLogins(home, async (name) => name === "app-13");
  expect(existsSync(ended)).toBe(false);
  expect(existsSync(running)).toBe(true);
});
