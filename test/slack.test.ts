// The Slack plugin, against a running daemon and a fake Slack: notes skel types into the lead
// reach a channel, direct messages from people on your list reach the lead, and the lead's
// answers go back. skel plugin turns it on and off.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Server, Subprocess } from "bun";
import { git, homeEnv, read, source, until as wait, writeScript } from "./harness.ts";

const main = source("main.ts");
const daemon = source("flow/daemon.ts");
let home = "";
let socket = "";
const running: Subprocess[] = [];

const data = () => join(home, ".local", "share", "skel");
const config = () => join(home, ".config", "skel");
const lead = () => read(join(data(), "claude", "lead", "typed"));

// The fake Slack: one token it accepts, a direct message channel for each person, the messages
// in each, newest first as Slack lists them, and every message skel posted.
type Said = { user?: string; bot_id?: string; subtype?: string; text: string; ts: string };
let slack: Server<undefined>;
const token = "xoxb-good";
let history: Record<string, Said[]> = {};
let posted: { channel: string; text: string }[] = [];
let calls: string[] = [];

// Answers one call to Slack's Web API, sent as a form, as Slack does: always 200, with ok
// saying whether it worked.
async function answerSlack(request: Request): Promise<Response> {
  const method = new URL(request.url).pathname.replace(/^\/+/, "");
  const form = new URLSearchParams(await request.text());
  calls.push(method === "conversations.open" ? `${method}:${form.get("users")}` : method);
  if (request.headers.get("Authorization") !== `Bearer ${token}`)
    return Response.json({ ok: false, error: "invalid_auth" });
  if (method === "auth.test") return Response.json({ ok: true, team: "Acme", user: "skel" });
  if (method === "conversations.open")
    return Response.json({ ok: true, channel: { id: `D${form.get("users")}` } });
  if (method === "conversations.history") {
    const oldest = Number(form.get("oldest") ?? "0");
    const messages = (history[form.get("channel") ?? ""] ?? []).filter(
      (m) => Number(m.ts) > oldest,
    );
    return Response.json({
      ok: true,
      messages: messages.slice(0, Number(form.get("limit") ?? 100)),
    });
  }
  if (method === "chat.postMessage") {
    posted.push({ channel: form.get("channel") ?? "", text: form.get("text") ?? "" });
    return Response.json({ ok: true, ts: "1.0" });
  }
  return Response.json({ ok: false, error: "unknown_method" });
}

// Puts a program of the test's on its PATH.
const script = (name: string, body: string) => writeScript(home, name, body);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-slack-test-")));
  socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  history = {};
  posted = [];
  calls = [];
  slack = Bun.serve({ port: 0, fetch: answerSlack });
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  mkdirSync(join(home, "gh"));
  // The lead keeps what is typed into it. A builder can't start, so a thread fails at once.
  script(
    "claude",
    `case "$CLAUDE_CONFIG_DIR" in */lead) stty -echo; echo "❯"; exec cat > "$CLAUDE_CONFIG_DIR/typed" ;; esac
echo "Not logged in"; exit 1`,
  );
  script("systemd-run", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // The fake GitHub: issue 12 in simon/app, labeled skel once the file labeled is there.
  script(
    "gh",
    `case "$*" in
"api repos/simon/app/issues/12") echo '{"number":12,"title":"Add export","body":"As JSON"}' ;;
"api graphql --input -") cat > /dev/null
  if test -e "$HOME/gh/labeled"; then labeled='{"number":12,"title":"Add export"}'; fi
  echo "{\\"data\\":{\\"viewer\\":{\\"login\\":\\"simon\\"},\\"repository\\":{\\"labeled\\":{\\"nodes\\":[$labeled]}}}}" ;;
"api repos/simon/app/labels --method POST --input -") cat > /dev/null; echo '{"name":"skel"}' ;;
"api repos/simon/app/issues/12/reactions --method POST --input -") cat > /dev/null; echo '{"content":"eyes"}' ;;
*) echo "the fake gh doesn't know $*" >&2; exit 1 ;;
esac`,
  );
  mkdirSync(config(), { recursive: true });
  writeFileSync(join(config(), "config.yaml"), "harness: claude\nreviewer: { harness: codex }\n");
  writeFileSync(join(config(), "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skel.service"), "");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${join(home, "github")}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Simon\n\temail = simon@example.com\n`,
  );
});
afterEach(async () => {
  for (const serve of running.splice(0)) {
    serve.kill();
    await serve.exited;
  }
  slack.stop(true);
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
  rmSync(home, { recursive: true, force: true });
});

// What this test's processes run with: its home, and the fake Slack in place of Slack.
const env = () => ({ ...homeEnv(home), SKEL_SLACK_URL: `http://localhost:${slack.port}` });

// Turns the Slack plugin on the way skel plugin add leaves it, without asking.
function slackOn(): void {
  mkdirSync(join(config(), "plugins"), { recursive: true });
  writeFileSync(join(config(), "plugins", "slack"), `${token}\n`, { mode: 0o600 });
  writeFileSync(
    join(config(), "config.yaml"),
    "harness: claude\nreviewer: { harness: codex }\nplugins:\n  slack:\n    channel: C1\n    people: [UANA]\n",
  );
}

// Runs the daemon, polling every 200 milliseconds, so it checks Slack every 400.
function serve(): Subprocess {
  const code = `import { serve } from ${JSON.stringify(daemon)};
await serve(${JSON.stringify(socket)}, 200);`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: env(),
    stdout: "ignore",
    stderr: "ignore",
  });
  running.push(run);
  return run;
}

// Runs skel, as you or, with SKEL_SOCKET pointing at the lead's socket, as the lead.
async function skel(args: string[], more: Record<string, string> = {}, typed = "") {
  const run = Bun.spawn([process.execPath, main, ...args], {
    env: { ...env(), ...more },
    stdin: new Blob([typed]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code };
}

const asLead = () => ({
  SKEL_SOCKET: join(home, "run", "skel", "lead", "skel.sock"),
  SKEL_SANDBOX: "1",
});

// A daemon's work takes its time here, so a wait lasts 15 seconds.
const until = (done: () => boolean) => wait(done, { timeout: 15_000 });

// Waits until skel has checked Slack a few more times, so anything those checks do is done.
async function moreChecks(n = 3) {
  const seen = () => calls.filter((c) => c === "conversations.history").length;
  const before = seen();
  await until(() => seen() >= before + n);
}

// Puts simon/app on the fake GitHub and tells skel about it.
function addApp(): void {
  const work = join(home, "work", "app");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README"), "app\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, join(home, "github", "simon", "app.git"));
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");`;
  const added = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!added.success) throw new Error(added.stderr.toString());
}

describe.skipIf(process.env.SKEL_SANDBOX === "1")("with the daemon", () => {
  test("a note skel types into the lead also goes to the Slack channel", async () => {
    slackOn();
    addApp();
    serve();
    writeFileSync(join(home, "gh", "labeled"), "");
    await until(() => lead().includes("started app-12 from GitHub: Add export"));
    await until(() => posted.length > 0);
    expect(posted).toEqual([{ channel: "C1", text: "started app-12 from GitHub: Add export" }]);
  }, 30_000);

  test("a message from someone on your list reaches the lead once, and nobody else's does", async () => {
    slackOn();
    // Said before skel first looked, so it is history, not news.
    history.DUANA = [{ user: "UANA", text: "old news", ts: "100.000001" }];
    history.DUEVE = [];
    serve();
    await moreChecks();
    history.DUANA = [
      { user: "UANA", text: "is app-12 close?\nno rush", ts: "200.000001" },
      { bot_id: "B1", user: "USKEL", text: "an answer of skel's own", ts: "150.000001" },
      ...(history.DUANA ?? []),
    ];
    await until(() => lead().includes("is app-12 close? no rush"));
    expect(lead()).toContain('skel reply slack:UANA "<answer>"');
    expect(lead()).not.toContain("old news");
    expect(lead()).not.toContain("an answer of skel's own");
    // Nor after a restart.
    const first = running[0];
    first?.kill();
    await first?.exited;
    serve();
    await moreChecks();
    expect(lead().split("is app-12 close?").length - 1).toBe(1);
    // Notes that came from Slack aren't sent back to it.
    expect(posted).toEqual([]);
    // Someone off the list is never asked about.
    expect(calls).not.toContain("conversations.open:UEVE");
  }, 30_000);

  test("the lead's answer goes back to the person, and never to someone off your list", async () => {
    slackOn();
    serve();
    await moreChecks(1);
    const sent = await skel(["reply", "slack:UANA", "Yes, in review."], asLead());
    expect(sent.err).toBe("");
    expect(sent.code).toBe(0);
    expect(posted).toEqual([{ channel: "DUANA", text: "Yes, in review." }]);
    const refused = await skel(["reply", "slack:UEVE", "the secrets"], asLead());
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("UEVE isn't on your list");
    const unknown = await skel(["reply", "irc:bob", "hi"], asLead());
    expect(unknown.err).toContain("no plugin that is on answers irc");
    expect(posted).toHaveLength(1);
  }, 30_000);
});

test("skel plugin add slack checks the token, keeps it private and saves the settings", async () => {
  const listed = await skel(["plugin", "ls"]);
  expect(listed.out).toMatch(/slack\s+off/);
  const bad = await skel(["plugin", "add", "slack"], {}, "xoxb-wrong\n");
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("invalid_auth");
  expect(existsSync(join(config(), "plugins", "slack"))).toBe(false);
  const added = await skel(["plugin", "add", "slack"], {}, `${token}\nC1\nUANA, UBEN\n`);
  expect(added.err).toBe("");
  expect(added.code).toBe(0);
  expect(added.out).toContain("Acme");
  const saved = join(config(), "plugins", "slack");
  expect(readFileSync(saved, "utf8").trim()).toBe(token);
  expect(statSync(saved).mode & 0o777).toBe(0o600);
  const yaml = readFileSync(join(config(), "config.yaml"), "utf8");
  expect(yaml).toContain("harness: claude");
  expect(yaml).toContain("channel: C1");
  expect(yaml).toContain("UBEN");
  expect((await skel(["plugin", "ls"])).out).toMatch(/slack\s+on/);
  const removed = await skel(["plugin", "rm", "slack"]);
  expect(removed.code).toBe(0);
  expect(existsSync(saved)).toBe(false);
  const after = readFileSync(join(config(), "config.yaml"), "utf8");
  expect(after).not.toContain("slack");
  expect(after).toContain("harness: claude");
  expect((await skel(["plugin", "ls"])).out).toMatch(/slack\s+off/);
});

test("skel plugin add refuses a name skel has no plugin for, and settings that aren't Slack's", async () => {
  const unknown = await skel(["plugin", "add", "irc"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("skel has no plugin called irc");
  const channel = await skel(["plugin", "add", "slack"], {}, `${token}\n#general\nUANA\n`);
  expect(channel.code).toBe(1);
  expect(channel.err).toContain("channel ID");
  expect(existsSync(join(config(), "plugins", "slack"))).toBe(false);
});

test("an agent can't turn a plugin on or off", async () => {
  for (const sub of ["add", "rm", "ls"]) {
    const run = await skel(["plugin", sub, "slack"], { SKEL_SANDBOX: "1" });
    expect(run.code).toBe(1);
    expect(run.err).toContain("only for your own terminal");
  }
});
