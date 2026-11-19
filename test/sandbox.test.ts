// The sandbox around every agent, run for real with bubblewrap, under a home folder of the
// test's own so nothing touches your real ~/.claude.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
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
import { claude } from "../src/agents/claude.ts";
import { codex } from "../src/agents/codex.ts";
import { setupCommand } from "../src/agents/sandbox.ts";
import { insideSandbox, source } from "./harness.ts";

let home = "";
let socket: ReturnType<typeof Bun.listen> | undefined;
let socketPath = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-sandbox-test-")));
  // Alone in a folder of its own, as the sandbox mounts the folder.
  mkdirSync(join(home, "socket"));
  socketPath = join(home, "socket", "skelcrew.sock");
  socket = Bun.listen({ unix: socketPath, socket: { data() {} } });
});
afterEach(() => {
  socket?.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const path = () => `${join(home, "bin")}:${process.env.PATH ?? ""}`;

// Runs a program and gives back what it printed and its code. Bun warns "Slow filesystem
// detected" on a busy machine, so that one line of Bun's is left out of what it printed to
// stderr. Anything else there, warnings included, still shows to a test that checks for nothing.
async function run(argv: string[], env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, printed, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun colours the word when stderr is a terminal, so the colour goes before the line is read.
  const err = printed
    .split(/(?<=\n)/)
    .filter((line) => !Bun.stripANSI(line).startsWith("warn: Slow filesystem detected. "))
    .join("");
  return { out, err, code };
}

function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!done.success) throw new Error(done.stderr.toString());
}

// Skelcrew's clone of a repository, with one file in it.
function repository() {
  const repo = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README"), "app\n");
  git(repo, "init", "-q");
  return repo;
}

// What a lead's start is given: where app's lead works, and app's clone, which it sees. The
// clone goes along only once a test made it, as bwrap can't mount a folder that is missing.
function lead(): { folder: string; origin?: string } {
  const folder = join(home, ".local", "share", "skelcrew", "leads", "simon", "app");
  const repo = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  return existsSync(repo) ? { folder, origin: repo } : { folder };
}

// Stands in for Claude Code: reports what it was given, sees and may change.
function fakeClaude(script: string[]) {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "claude"), ["#!/bin/sh", ...script].join("\n"), {
    mode: 0o755,
  });
}

function saveToken() {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "tok-123\n", { mode: 0o600 });
}

const outside = () => ({
  HOME: home,
  PATH: path(),
  TERM: "xterm",
  CLAUDE_CODE_CHILD_SESSION: "1",
  GH_TOKEN: "secret",
  SKELCREW_GITHUB_APP_KEY: "secret",
});

// Runs a shell script as the lead's Claude Code, inside its sandbox.
function asLead(script: string) {
  saveToken();
  fakeClaude([script]);
  const { argv, env } = claude.start({
    ...lead(),
    name: "lead",
    socket: socketPath,
    model: "opus",
    env: outside(),
  });
  return run(argv, env);
}

// Claude Code's agent view keeps a service in the session's config folder that can hand a
// restarted lead a spare session of its own, on the default model, without its conversation
// or instructions. Nothing is started here, so this runs inside Skelcrew's sandbox too.
test("Claude Code starts every agent with its agent view off", () => {
  saveToken();
  const { env } = claude.start({ ...lead(), name: "lead", socket: socketPath, env: outside() });
  expect(env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe("1");
});

// bubblewrap can't start inside Skelcrew's own sandbox, so only there these tests can't run.
describe.skipIf(insideSandbox)("sandbox", () => {
  test("the lead writes in its folder and nowhere else", async () => {
    const repo = repository();
    const { folder } = lead();
    const done = await asLead(
      `pwd; echo hi > note && cat note; cat ${repo}/README; echo x > ${repo}/new; echo x > /usr/new; echo x > /tmp/ok && echo tmp-ok`,
    );
    expect(done.out).toBe(`${folder}\nhi\napp\ntmp-ok\n`);
    expect(done.err).toContain("Read-only file system");
    expect(readFileSync(join(folder, "note"), "utf8")).toBe("hi\n");
    expect(existsSync(join(repo, "new"))).toBe(false);
  });

  test("starts from a checkout of Skelcrew with no node_modules", async () => {
    // bun runs sc without node_modules by fetching its packages itself, so a fresh clone
    // works until the sandbox asks for the folder.
    const copy = join(home, "skel");
    mkdirSync(copy);
    for (const part of ["bin", "src", "package.json"])
      cpSync(join(import.meta.dir, "..", part), join(copy, part), { recursive: true });
    repository();
    saveToken();
    fakeClaude(["echo started"]);
    const script = join(home, "start.ts");
    writeFileSync(
      script,
      `import { claude } from ${JSON.stringify(join(copy, "src", "agents", "claude.ts"))};
console.log(JSON.stringify(claude.start({ name: "lead", ...${JSON.stringify(lead())},
  socket: ${JSON.stringify(socketPath)}, model: "opus", env: ${JSON.stringify(outside())} })));`,
    );
    const made = await run([process.execPath, script]);
    expect(made.err).toBe("");
    const { argv, env } = JSON.parse(made.out);
    const done = await run(argv, env);
    expect(done.err).toBe("");
    expect(done.out).toBe("started\n");
  });

  test("brings back the whole package a program's link points into", async () => {
    // Codex from npm links to bin/codex.js in its package, which runs a program kept in
    // another folder of the same package.
    repository();
    saveToken();
    const pkg = join(home, "nvm", "lib", "node_modules", "pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(pkg, "vendor"));
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(pkg, "vendor", "real"), "#!/bin/sh\necho real\n", { mode: 0o755 });
    writeFileSync(join(pkg, "bin", "cli"), `#!/bin/sh\nexec ${pkg}/vendor/real\n`, {
      mode: 0o755,
    });
    mkdirSync(join(home, "bin"));
    symlinkSync(join(pkg, "bin", "cli"), join(home, "bin", "claude"));
    writeFileSync(join(home, "nvm", "secret"), "x");
    const { argv, env } = claude.start({
      ...lead(),
      name: "lead",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    argv.splice(argv.indexOf("--") + 1);
    argv.push("sh", "-c", `claude; test -e ${home}/nvm/secret || echo hidden`);
    const done = await run(argv, env);
    expect(done.err).toBe("");
    expect(done.out).toBe("real\nhidden\n");
  });

  test("brings back a program behind two links, and nothing beside its package", async () => {
    // Codex's installer links ~/.local/bin/codex to current/bin/codex, and current to the
    // release, so the second link sits in a folder that is neither the program's nor its
    // package's. That folder sits in ~/.codex, beside your login.
    repository();
    saveToken();
    const codex = join(home, ".codex");
    const standalone = join(codex, "packages", "standalone");
    const release = join(standalone, "releases", "1.0-linux");
    mkdirSync(join(release, "bin"), { recursive: true });
    mkdirSync(join(release, "codex-path"));
    writeFileSync(join(release, "codex-package.json"), "{}");
    writeFileSync(join(release, "codex-path", "rg"), "#!/bin/sh\necho real\n", { mode: 0o755 });
    // Finds what it needs beside its real file, as Codex does.
    const launcher = 'exec "$(dirname "$(readlink -f "$0")")/../codex-path/rg"';
    writeFileSync(join(release, "bin", "codex"), `#!/bin/sh\n${launcher}\n`, { mode: 0o755 });
    symlinkSync(join("releases", "1.0-linux"), join(standalone, "current"));
    mkdirSync(join(home, "bin"));
    symlinkSync(join(standalone, "current", "bin", "codex"), join(home, "bin", "claude"));
    writeFileSync(join(codex, "auth.json"), "secret");
    writeFileSync(join(codex, "config.toml"), "secret");
    // Without a mark of its own, the release would pass for part of this package.
    writeFileSync(join(codex, "package.json"), "{}");
    writeFileSync(join(standalone, "selection-history"), "secret");
    const { argv, env } = claude.start({
      ...lead(),
      name: "lead",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    argv.splice(argv.indexOf("--") + 1);
    // By its full path: with the link broken, a bare name would find your real claude.
    const program = join(home, "bin", "claude");
    argv.push("sh", "-c", `${program}; cd ${codex} && find . ! -type d | sort`);
    const done = await run(argv, env);
    expect(done.err).toBe("");
    expect(done.out.split("\n")).toEqual([
      "real",
      "./packages/standalone/current",
      "./packages/standalone/releases/1.0-linux/bin/codex",
      "./packages/standalone/releases/1.0-linux/codex-package.json",
      "./packages/standalone/releases/1.0-linux/codex-path/rg",
      "",
    ]);
  });

  test("starts when a program's link passes through a folder on the PATH", async () => {
    // tool reaches its file through current, and the same folder is on the PATH for other,
    // which comes back as a folder. bubblewrap can't mount a folder through a link it made.
    const versions = join(home, "tools", "1.0", "bin");
    mkdirSync(versions, { recursive: true });
    mkdirSync(join(home, "bin"));
    writeFileSync(join(versions, "tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
    writeFileSync(join(versions, "other"), "#!/bin/sh\necho other\n", { mode: 0o755 });
    const current = join(home, "tools", "current");
    symlinkSync(join(home, "tools", "1.0"), current);
    symlinkSync(join(current, "bin", "tool"), join(home, "bin", "tool"));
    const folder = join(home, "work");
    mkdirSync(folder);
    const { argv, env } = setupCommand(folder, "tool ; other", {
      HOME: home,
      PATH: `${join(home, "bin")}:${join(current, "bin")}:${process.env.PATH ?? ""}`,
    });
    const done = await run(argv, env);
    expect(done.err).toBe("");
    expect(done.out).toBe("tool\nother\n");
  });

  test("hides the home folder's secrets and the other sockets in /run", async () => {
    repository();
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: secret\n");
    const done = await asLead(
      `test -e ${home}/.config/gh/hosts.yml || echo hidden; ls /run; ls /run/systemd 2>/dev/null; ls /run/skelcrew; test -S "$SKELCREW_SOCKET" && echo socket; echo $SKELCREW_SANDBOX`,
    );
    // Only the DNS resolver comes back into /run, on machines that have one there.
    const resolver = existsSync("/run/systemd/resolve") ? "systemd\nresolve\n" : "";
    expect(done.out).toBe(`hidden\nskelcrew\n${resolver}skelcrew.sock\nsocket\n1\n`);
  });

  test("Postgres clients reach localhost over TCP, since the sandbox hides their socket in /tmp", async () => {
    repository();
    const done = await asLead("echo $PGHOST");
    expect(done.out).toBe("localhost\n");
  });

  test("the agent runs sc from this checkout", async () => {
    repository();
    const done = await asLead("command -v sc");
    expect(done.out).toBe(`${join(import.meta.dir, "..", "bin", "sc")}\n`);
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

  // The settings every Claude Code agent starts with: bypass mode with no warning, its own sandbox
  // off, and the hooks that tell Skelcrew what it is doing.
  const hook = (command: string) => ({ type: "command", command, timeout: 10 });
  const agentSettings = JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    sandbox: { enabled: false },
    hooks: {
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook("sc question asked")] }],
      PostToolUse: [{ matcher: "AskUserQuestion", hooks: [hook("sc question closed")] }],
      UserPromptSubmit: [{ hooks: [hook("sc question answered")] }],
      StopFailure: [{ hooks: [hook("sc turn failed")] }],
      Stop: [{ hooks: [hook("sc turn ended")] }],
    },
  });

  test("Claude Code starts in its own config folder, trusted, with Skelcrew's token", async () => {
    repository();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), '{"projects":{}}\n');
    const yours = () =>
      snapshot(join(home, ".claude")) + readFileSync(join(home, ".claude.json"), "utf8");
    const before = yours();
    saveToken();
    mkdirSync(join(home, ".local", "share", "skelcrew", "claude", "other"), { recursive: true });
    fakeClaude([
      'printf "%s\\n" "$@"',
      "env | grep -E '^(CLAUDE_|DISABLE_AUTOUPDATER|SKEL|GH_TOKEN|TERM)' | sort",
      "test -e ~/.claude || echo no-claude",
      "test -e ~/.claude.json || echo no-claude-json",
      "test -e ~/.config/skelcrew/claude-token || echo no-token-file",
      "test -e ~/.local/share/skelcrew/claude/other || echo no-other-session",
      "echo m > $CLAUDE_CONFIG_DIR/note && echo kept",
      "mkdir -p ~/.claude && echo x > ~/.claude/settings.json",
    ]);
    const { argv, env } = claude.start({
      ...lead(),
      name: "app-12",
      socket: socketPath,
      model: "opus",
      prompt: "Fix the bug",
      resume: "abc-123",
      env: outside(),
    });
    const config = join(home, ".local", "share", "skelcrew", "claude", "app-12");
    const done = await run(argv, env);
    expect(done.err).toBe("");
    expect(done.out).toBe(
      [
        "--model",
        "opus",
        "--permission-mode",
        "bypassPermissions",
        "--settings",
        agentSettings,
        "--resume",
        "abc-123",
        "--",
        "Fix the bug",
        "CLAUDE_CODE_DISABLE_AGENT_VIEW=1",
        "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false",
        "CLAUDE_CODE_HARBOR_KITE=false",
        "CLAUDE_CODE_OAUTH_TOKEN=tok-123",
        `CLAUDE_CONFIG_DIR=${config}`,
        "DISABLE_AUTOUPDATER=1",
        "SKELCREW_SANDBOX=1",
        "SKELCREW_SOCKET=/run/skelcrew/skelcrew.sock",
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
    const { folder } = lead();
    expect(JSON.parse(readFileSync(json, "utf8")).projects[folder].hasTrustDialogAccepted).toBe(
      true,
    );
    // Its first-launch questions, such as the theme, would wait with nobody to answer.
    expect(JSON.parse(readFileSync(json, "utf8")).hasCompletedOnboarding).toBe(true);
    expect(statSync(json).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(config, "note"), "utf8")).toBe("m\n");
    expect(yours()).toBe(before);
  });

  test("a builder runs at a lower CPU priority than the lead, so the screen stays quick", async () => {
    repository();
    saveToken();
    fakeClaude(["nice"]);
    const start = (more: { name: string; thread?: string }) =>
      claude.start({ ...lead(), ...more, socket: socketPath, model: "opus", env: outside() });
    const thread = join(home, ".local", "share", "skelcrew", "threads", "app-12");
    const builder = start({ name: "app-12", thread });
    const theLead = start({ name: "lead" });
    const own = Number(Bun.spawnSync(["nice"], { stdout: "pipe" }).stdout.toString());
    expect(Number((await run(builder.argv, builder.env)).out)).toBe(Math.min(own + 10, 19));
    expect(Number((await run(theLead.argv, theLead.env)).out)).toBe(own);
  });

  test("a setup command from the repository runs at a lower CPU priority", async () => {
    const folder = join(home, "work");
    mkdirSync(folder);
    const { argv, env } = setupCommand(folder, "nice", outside());
    const own = Number(Bun.spawnSync(["nice"], { stdout: "pipe" }).stdout.toString());
    expect(Number((await run(argv, env)).out)).toBe(Math.min(own + 10, 19));
  });

  test("each session gets a config folder of its own", async () => {
    repository();
    saveToken();
    fakeClaude(["ls -A ~/.local/share/skelcrew/claude"]);
    const first = claude.start({
      ...lead(),
      name: "app-12",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    const second = claude.start({
      ...lead(),
      name: "app-12-review-1",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    expect(first.env.CLAUDE_CONFIG_DIR).not.toBe(second.env.CLAUDE_CONFIG_DIR);
    expect((await run(second.argv, second.env)).out).toBe("app-12-review-1\n");
  });
});

// These never start bubblewrap, so they run inside Skelcrew's sandbox too.
describe("starting Claude Code", () => {
  test("won't write a session's settings through a link the agent left", () => {
    repository();
    saveToken();
    const start = () =>
      claude.start({
        ...lead(),
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      });
    start();
    const config = join(home, ".local", "share", "skelcrew", "claude", "app-12");
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

  // Claude Code reads a first message that starts with dashes, such as a task titled
  // "--from", as an option it doesn't know, and exits before the builder does anything.
  test("passes the first message after --, so it is never read as an option", () => {
    repository();
    saveToken();
    const prompt = "--from\n\nskelcrew/298-the-list";
    const { argv } = claude.start({
      ...lead(),
      name: "app-t3",
      socket: socketPath,
      model: "opus",
      prompt,
      sessionId: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      env: outside(),
    });
    expect(argv.slice(-2)).toEqual(["--", prompt]);
    expect(argv.filter((a) => a === prompt)).toHaveLength(1);
  });

  // Claude Code ignores this setting when it comes only from --settings, and then runs in
  // manual mode, stopping at prompts nobody answers.
  test("skips the bypass warning in each session's own settings, keeping what else is there", () => {
    repository();
    saveToken();
    const start = (name: string) =>
      claude.start({ ...lead(), name, socket: socketPath, model: "opus", env: outside() });
    const configs = join(home, ".local", "share", "skelcrew", "claude");
    const read = (name: string) =>
      JSON.parse(readFileSync(join(configs, name, "settings.json"), "utf8"));
    start("lead");
    expect(read("lead")).toEqual({ skipDangerousModePermissionPrompt: true });
    // A session started before Skelcrew wrote the file gets it when it starts again.
    mkdirSync(join(configs, "app-t3"), { recursive: true });
    writeFileSync(join(configs, "app-t3", "settings.json"), '{"theme":"dark"}\n');
    start("app-t3");
    expect(read("app-t3")).toEqual({ theme: "dark", skipDangerousModePermissionPrompt: true });
    expect(statSync(join(configs, "app-t3", "settings.json")).mode & 0o777).toBe(0o600);
    // An agent can change its own folder, so a link there is refused, never followed.
    const yours = join(home, "yours.json");
    writeFileSync(yours, "{}\n");
    rmSync(join(configs, "app-t3", "settings.json"));
    symlinkSync(yours, join(configs, "app-t3", "settings.json"));
    expect(() => start("app-t3")).toThrow("link");
    expect(readFileSync(yours, "utf8")).toBe("{}\n");
  });

  test("refuses a session settings file that isn't a plain file, without hanging", async () => {
    repository();
    saveToken();
    const config = join(home, ".local", "share", "skelcrew", "claude", "app-12");
    mkdirSync(config, { recursive: true });
    Bun.spawnSync(["mkfifo", join(config, ".claude.json")]);
    const script = `import { claude } from ${JSON.stringify(source("agents/claude.ts"))};
claude.start({ name: "app-12", socket: "x", model: "opus", ...${JSON.stringify(lead())} });`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, ...outside() },
      stdout: "pipe",
      stderr: "pipe",
      // A process that hangs on the file is ended here. Starting one can take many seconds on
      // a busy machine, so the limit is generous.
      timeout: 30_000,
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(proc.signalCode).toBeNull();
    expect(code).not.toBe(0);
    expect(err).toContain("isn't a plain file");
    rmSync(join(config, ".claude.json"));
    mkdirSync(join(config, ".claude.json"));
    expect(() =>
      claude.start({
        ...lead(),
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("isn't a plain file");
  });

  test("starts a new session under the ID it is given, which must be a UUID", () => {
    repository();
    saveToken();
    const id = "6f1c2a7e-0b4d-4c3e-9a51-2d8e7f6a9b10";
    const start = (more: { sessionId?: string; resume?: string }) =>
      claude.start({
        ...lead(),
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
      claude.start({
        ...lead(),
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
    expect(start).toThrow("credential helper");
    git(repo, "config", "--unset", "include.path");
    for (const [key, value] of credentials) {
      git(repo, "config", key, value);
      expect(start).toThrow("credential helper");
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
      claude.start({
        ...lead(),
        name: "lead",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("config");
  });

  test("gives the agent a /proc of its own", () => {
    repository();
    saveToken();
    const { argv } = claude.start({
      ...lead(),
      name: "lead",
      socket: socketPath,
      model: "opus",
      env: { ...outside(), PATH: "/usr/bin:/bin" },
    });
    expect(argv[0]).toBe("bwrap");
    const options = argv.slice(0, argv.indexOf("--")).join(" ");
    expect(options).toContain("--proc /proc");
    expect(options).toContain("--unshare-pid");
  });

  test("says to run sc first when there is no token", () => {
    repository();
    expect(() =>
      claude.start({
        ...lead(),
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("run sc");
  });
});

// A key for one harness's model is yours to spend, so only that harness's agents get it.
const withKeys = () => ({ ...outside(), ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai" });

test("a setup command from the repository gets no API key", () => {
  const { env } = setupCommand(join(home, "work"), "bun install", withKeys());
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

test("a Codex builder runs at a lower CPU priority, and its lead doesn't", async () => {
  const start = (more: { name: string; thread?: string }) =>
    codex.start({
      ...lead(),
      ...more,
      socket: socketPath,
      env: { ...outside(), PATH: "/usr/bin:/bin" },
    });
  const thread = join(home, ".local", "share", "skelcrew", "threads", "app-12");
  expect((await start({ name: "app-12", thread })).argv.slice(0, 4)).toEqual([
    "nice",
    "-n",
    "10",
    "bwrap",
  ]);
  expect((await start({ name: "lead" })).argv[0]).toBe("bwrap");
});

test("a Codex session gets Codex's key and not Claude Code's", async () => {
  const { env } = await codex.start({
    ...lead(),
    name: "lead",
    socket: socketPath,
    env: withKeys(),
  });
  expect(env.OPENAI_API_KEY).toBe("sk-openai");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("a Claude Code session gets Claude Code's key and not Codex's", () => {
  saveToken();
  const { env } = claude.start({
    ...lead(),
    name: "lead",
    socket: socketPath,
    model: "opus",
    env: withKeys(),
  });
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
  expect(env.OPENAI_API_KEY).toBeUndefined();
});
