// The sandbox around every agent, run for real with bubblewrap, under a home folder of the
// test's own so nothing touches your real ~/.claude.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../src/sandbox.ts";

let home = "";
let socket: ReturnType<typeof Bun.listen> | undefined;
let socketPath = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-sandbox-test-")));
  // Alone in a folder of its own, as the sandbox mounts the folder.
  mkdirSync(join(home, "socket"));
  socketPath = join(home, "socket", "skel.sock");
  socket = Bun.listen({ unix: socketPath, socket: { data() {} } });
});
afterEach(() => {
  socket?.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const path = () => `${join(home, "bin")}:${process.env.PATH ?? ""}`;

async function run(argv: string[], env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!done.success) throw new Error(done.stderr.toString());
}

// A repository the lead looks after, with one file in it.
function repository() {
  const repo = join(home, "code", "app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README"), "app\n");
  git(repo, "init", "-q");
  return repo;
}

// Stands in for Claude Code: reports what it was given, sees and may change.
function fakeClaude(script: string[]) {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "claude"), ["#!/bin/sh", ...script].join("\n"), {
    mode: 0o755,
  });
}

function saveToken() {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "claude-token"), "tok-123\n", { mode: 0o600 });
}

const outside = () => ({
  HOME: home,
  PATH: path(),
  TERM: "xterm",
  CLAUDE_CODE_CHILD_SESSION: "1",
  GH_TOKEN: "secret",
  SKEL_GITHUB_APP_KEY: "secret",
});

// Runs a shell script as the lead's Claude Code, inside its sandbox.
function asLead(repositories: string[], script: string) {
  saveToken();
  fakeClaude([script]);
  const { argv, env } = agentCommand({
    repositories,
    name: "lead",
    socket: socketPath,
    model: "opus",
    env: outside(),
  });
  return run(argv, env);
}

// bubblewrap can't start inside skel's own sandbox, so only there these tests can't run.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("sandbox", () => {
  test("the lead writes in its folder and nowhere else", async () => {
    const repo = repository();
    const lead = join(home, ".local", "share", "skel", "lead");
    const done = await asLead(
      [repo],
      `pwd; echo hi > note && cat note; cat ${repo}/README; echo x > ${repo}/new; echo x > /usr/new; echo x > /tmp/ok && echo tmp-ok`,
    );
    expect(done.out).toBe(`${lead}\nhi\napp\ntmp-ok\n`);
    expect(done.err).toContain("Read-only file system");
    expect(readFileSync(join(lead, "note"), "utf8")).toBe("hi\n");
    expect(existsSync(join(repo, "new"))).toBe(false);
  });

  test("hides threads' folders", async () => {
    const repo = repository();
    mkdirSync(join(repo, ".skel", "threads", "12"), { recursive: true });
    writeFileSync(join(repo, ".skel", "threads", "12", "work"), "draft\n");
    const done = await asLead([repo], `ls -A ${repo}/.skel; cat ${repo}/README`);
    expect(done.out).toBe("app\n");
  });

  test("makes the threads' folder before the lead starts, so later threads stay hidden", async () => {
    const repo = repository();
    await asLead([repo], "true");
    expect(existsSync(join(repo, ".skel"))).toBe(true);
  });

  test("hides the home folder's secrets and the other sockets in /run", async () => {
    const repo = repository();
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: secret\n");
    const done = await asLead(
      [repo],
      `test -e ${home}/.config/gh/hosts.yml || echo hidden; ls /run; ls /run/systemd 2>/dev/null; ls /run/skel; test -S "$SKEL_SOCKET" && echo socket; echo $SKEL_SANDBOX`,
    );
    // Only the DNS resolver comes back into /run, on machines that have one there.
    const resolver = existsSync("/run/systemd/resolve") ? "systemd\nresolve\n" : "";
    expect(done.out).toBe(`hidden\nskel\n${resolver}skel.sock\nsocket\n1\n`);
  });

  // Every file under a folder with its contents, to show nothing in it changed.
  function snapshot(folder: string): string {
    const listed = Bun.spawnSync([
      "sh",
      "-c",
      `cd ${folder} && find . -type f | sort | xargs -r cat`,
    ]);
    const names = Bun.spawnSync(["sh", "-c", `cd ${folder} && find . | sort`]);
    return names.stdout.toString() + listed.stdout.toString();
  }

  test("Claude Code starts in its own config folder, trusted, with skel's token", async () => {
    const repo = repository();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), '{"projects":{}}\n');
    const yours = () =>
      snapshot(join(home, ".claude")) + readFileSync(join(home, ".claude.json"), "utf8");
    const before = yours();
    saveToken();
    mkdirSync(join(home, ".local", "share", "skel", "claude", "other"), { recursive: true });
    fakeClaude([
      'printf "%s\\n" "$@"',
      "env | grep -E '^(CLAUDE_|SKEL_|GH_TOKEN|TERM)' | sort",
      "test -e ~/.claude || echo no-claude",
      "test -e ~/.claude.json || echo no-claude-json",
      "test -e ~/.config/skel/claude-token || echo no-token-file",
      "test -e ~/.local/share/skel/claude/other || echo no-other-session",
      "echo m > $CLAUDE_CONFIG_DIR/note && echo kept",
      "mkdir -p ~/.claude && echo x > ~/.claude/settings.json",
    ]);
    const { argv, env } = agentCommand({
      repositories: [repo],
      name: "app-12",
      socket: socketPath,
      model: "opus",
      prompt: "Fix the bug",
      resume: "abc-123",
      env: outside(),
    });
    const config = join(home, ".local", "share", "skel", "claude", "app-12");
    const done = await run(argv, env);
    expect(done.err).toBe("");
    expect(done.out).toBe(
      [
        "--model",
        "opus",
        "--permission-mode",
        "bypassPermissions",
        "--settings",
        '{"skipDangerousModePermissionPrompt":true,"sandbox":{"enabled":false}}',
        "--resume",
        "abc-123",
        "Fix the bug",
        "CLAUDE_CODE_OAUTH_TOKEN=tok-123",
        `CLAUDE_CONFIG_DIR=${config}`,
        "SKEL_SANDBOX=1",
        "SKEL_SOCKET=/run/skel/skel.sock",
        "TERM=xterm",
        "no-claude",
        "no-claude-json",
        "no-token-file",
        "no-other-session",
        "kept",
        "",
      ].join("\n"),
    );
    const json = join(config, ".claude.json");
    const lead = join(home, ".local", "share", "skel", "lead");
    expect(JSON.parse(readFileSync(json, "utf8")).projects[lead].hasTrustDialogAccepted).toBe(true);
    expect(statSync(json).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(config, "note"), "utf8")).toBe("m\n");
    expect(yours()).toBe(before);
  });

  test("each session gets a config folder of its own", async () => {
    const repo = repository();
    saveToken();
    fakeClaude(["ls -A ~/.local/share/skel/claude"]);
    const first = agentCommand({
      repositories: [repo],
      name: "app-12",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    const second = agentCommand({
      repositories: [repo],
      name: "app-12-review-1",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    expect(first.env.CLAUDE_CONFIG_DIR).not.toBe(second.env.CLAUDE_CONFIG_DIR);
    expect((await run(second.argv, second.env)).out).toBe("app-12-review-1\n");
  });
});

// These never start bubblewrap, so they run inside skel's sandbox too.
describe("starting Claude Code", () => {
  test("won't write a session's settings through a link the agent left", () => {
    const repo = repository();
    saveToken();
    const start = () =>
      agentCommand({
        repositories: [repo],
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      });
    start();
    const config = join(home, ".local", "share", "skel", "claude", "app-12");
    const yours = join(home, ".claude.json");
    writeFileSync(yours, '{"projects":{}}\n');
    rmSync(join(config, ".claude.json"));
    symlinkSync(yours, join(config, ".claude.json"));
    expect(start).toThrow("link");
    expect(readFileSync(yours, "utf8")).toBe('{"projects":{}}\n');
    rmSync(join(config, ".claude.json"));
    symlinkSync(join(home, "made"), join(config, ".claude.json"));
    expect(start).toThrow("link");
    expect(existsSync(join(home, "made"))).toBe(false);
    rmSync(config, { recursive: true });
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), config);
    expect(start).toThrow("link");
    expect(readdirSync(join(home, "elsewhere"))).toEqual([]);
  });

  test("refuses a session settings file that isn't a plain file, without hanging", async () => {
    const repo = repository();
    saveToken();
    const config = join(home, ".local", "share", "skel", "claude", "app-12");
    mkdirSync(config, { recursive: true });
    Bun.spawnSync(["mkfifo", join(config, ".claude.json")]);
    const script = `import { agentCommand } from ${JSON.stringify(join(import.meta.dir, "..", "src", "sandbox.ts"))};
agentCommand({ repositories: [${JSON.stringify(repo)}], name: "app-12", socket: "x", model: "opus" });`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, ...outside() },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(proc.signalCode).toBeNull();
    expect(code).not.toBe(0);
    expect(err).toContain("isn't a plain file");
    rmSync(join(config, ".claude.json"));
    mkdirSync(join(config, ".claude.json"));
    expect(() =>
      agentCommand({
        repositories: [repo],
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("isn't a plain file");
  });

  test("starts a new session under the ID it is given, which must be a UUID", () => {
    const repo = repository();
    saveToken();
    const id = "6f1c2a7e-0b4d-4c3e-9a51-2d8e7f6a9b10";
    const start = (more: { sessionId?: string; resume?: string }) =>
      agentCommand({
        repositories: [repo],
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
        ...more,
      });
    const { argv } = start({ sessionId: id });
    expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual([
      "--session-id",
      id,
    ]);
    expect(() => start({ sessionId: "not-a-uuid" })).toThrow("UUID");
    expect(() => start({ sessionId: id, resume: id })).toThrow("both");
  });

  test("refuses a repository whose git config holds a credential", () => {
    const repo = repository();
    saveToken();
    const start = () =>
      agentCommand({
        repositories: [repo],
        name: "lead",
        socket: socketPath,
        model: "opus",
        env: outside(),
      });
    const credentials: [string, string][] = [
      ["remote.origin.url", "https://simon:ghp_secret@github.com/simon/app"],
      ["http.https://github.com/.extraheader", "AUTHORIZATION: basic c2VjcmV0"],
    ];
    // A config can pull in another file, which the lead can read as well.
    writeFileSync(
      join(repo, "extra.config"),
      '[remote "origin"]\n\turl = https://x:ghp_secret@github.com/a/b\n',
    );
    git(repo, "config", "include.path", "../extra.config");
    expect(start).toThrow("gh");
    git(repo, "config", "--unset", "include.path");
    for (const [key, value] of credentials) {
      git(repo, "config", key, value);
      expect(start).toThrow("gh");
      git(repo, "config", "--unset", key);
    }
    expect(start).not.toThrow();
  });

  test("refuses a repository whose git config can't be read", () => {
    const repo = repository();
    saveToken();
    // A config git can't parse hides whatever credential it holds from the check.
    appendFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"\n\turl = https://x:ghp_secret@github.com/a/b\n',
    );
    expect(() =>
      agentCommand({
        repositories: [repo],
        name: "lead",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("config");
  });

  test("says to run skel first when there is no token", () => {
    const repo = repository();
    expect(() =>
      agentCommand({
        repositories: [repo],
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("run skel");
  });
});
