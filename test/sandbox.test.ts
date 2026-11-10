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
import { source } from "./harness.ts";

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

// skel's clone of a repository, with one file in it.
function repository() {
  const repo = join(home, ".local", "share", "skel", "repos", "simon", "app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README"), "app\n");
  git(repo, "init", "-q");
  return repo;
}

// What a lead's start is given: where app's lead works, and app's clone, which it sees. The
// clone goes along only once a test made it, as bwrap can't mount a folder that is missing.
function lead(): { folder: string; origin?: string } {
  const folder = join(home, ".local", "share", "skel", "leads", "simon", "app");
  const repo = join(home, ".local", "share", "skel", "repos", "simon", "app");
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

// bubblewrap can't start inside skel's own sandbox, so only there these tests can't run.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("sandbox", () => {
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

  test("starts from a checkout of skel with no node_modules", async () => {
    // bun runs skel without node_modules by fetching its packages itself, so a fresh clone
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
      `test -e ${home}/.config/gh/hosts.yml || echo hidden; ls /run; ls /run/systemd 2>/dev/null; ls /run/skel; test -S "$SKEL_SOCKET" && echo socket; echo $SKEL_SANDBOX`,
    );
    // Only the DNS resolver comes back into /run, on machines that have one there.
    const resolver = existsSync("/run/systemd/resolve") ? "systemd\nresolve\n" : "";
    expect(done.out).toBe(`hidden\nskel\n${resolver}skel.sock\nsocket\n1\n`);
  });

  test("the agent runs skel from this checkout", async () => {
    repository();
    const done = await asLead("command -v skel");
    expect(done.out).toBe(`${join(import.meta.dir, "..", "bin", "skel")}\n`);
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
    repository();
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
      "env | grep -E '^(CLAUDE_|DISABLE_AUTOUPDATER|SKEL_|GH_TOKEN|TERM)' | sort",
      "test -e ~/.claude || echo no-claude",
      "test -e ~/.claude.json || echo no-claude-json",
      "test -e ~/.config/skel/claude-token || echo no-token-file",
      "test -e ~/.local/share/skel/claude/other || echo no-other-session",
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
        "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false",
        "CLAUDE_CODE_OAUTH_TOKEN=tok-123",
        `CLAUDE_CONFIG_DIR=${config}`,
        "DISABLE_AUTOUPDATER=1",
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

  test("each session gets a config folder of its own", async () => {
    repository();
    saveToken();
    fakeClaude(["ls -A ~/.local/share/skel/claude"]);
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

// These never start bubblewrap, so they run inside skel's sandbox too.
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
    repository();
    saveToken();
    const config = join(home, ".local", "share", "skel", "claude", "app-12");
    mkdirSync(config, { recursive: true });
    Bun.spawnSync(["mkfifo", join(config, ".claude.json")]);
    const script = `import { claude } from ${JSON.stringify(source("agents/claude.ts"))};
claude.start({ name: "app-12", socket: "x", model: "opus", ...${JSON.stringify(lead())} });`;
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

  // skel takes a machine with sprite-env, the Sprite's own tool, on its PATH for a Sprite.
  test("on a Sprite, gives the agent processes of its own, drops capabilities, and hides the Sprite's tools", () => {
    repository();
    saveToken();
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "sprite-env"), "#!/bin/sh\n", { mode: 0o755 });
    const { argv } = claude.start({
      ...lead(),
      name: "lead",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    expect(argv.slice(0, 11)).toEqual([
      "unshare",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount",
      "--mount-proc",
      "setpriv",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "bwrap",
    ]);
    const options = argv.slice(0, argv.indexOf("--")).join(" ");
    expect(options).toContain("--ro-bind /proc /proc");
    expect(options).not.toContain("--proc ");
    expect(options).not.toContain("--unshare-pid");
    expect(options).toContain("--ro-bind /dev/null /.sprite/api.sock");
    expect(options).toContain(`--ro-bind /dev/null ${join(home, "bin", "sprite-env")}`);
    // gh, bun and node live in /.sprite/bin, so nothing else of /.sprite is hidden.
    expect(options).not.toContain("--tmpfs /.sprite");
  });

  test("on a server, gives the agent a /proc of its own", () => {
    repository();
    saveToken();
    // Without the PATH this machine has, which on a Sprite holds sprite-env.
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
    expect(options).not.toContain(".sprite");
  });

  test("says to run skel first when there is no token", () => {
    repository();
    expect(() =>
      claude.start({
        ...lead(),
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("run skel");
  });
});

// A key for one harness's model is yours to spend, so only that harness's agents get it.
const withKeys = () => ({ ...outside(), ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai" });

test("a setup command from the repository gets no API key", () => {
  const { env } = setupCommand(join(home, "work"), "bun install", withKeys());
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
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

// Only a Sprite has its control socket, so these run only there, as when checking skel on a
// test Sprite, and never inside skel's own sandbox, where bubblewrap can't start.
describe.if(existsSync("/.sprite/api.sock") && process.env.SKEL_SANDBOX !== "1")(
  "on a Sprite",
  () => {
    test("the agent can't reach the control socket or sprite-env, but runs the Sprite's tools", async () => {
      repository();
      const done = await asLead(
        "test -S /.sprite/api.sock || echo hidden; command -v sprite-env || echo no-sprite-env; command -v gh; test -d /proc/1 && echo proc",
      );
      expect(done.err).toBe("");
      expect(done.out).toBe("hidden\nno-sprite-env\n/.sprite/bin/gh\nproc\n");
    });

    // Programs find themselves in /proc by their own process number, as setpriv does, and
    // stopping a process tree reads it too.
    test("the agent's /proc shows its own processes, by the numbers they have inside", async () => {
      repository();
      const done = await asLead(
        `cut -d" " -f1 /proc/$$/stat; echo $$; test -e /proc/${process.pid}/cmdline || echo outside-hidden`,
      );
      expect(done.err).toBe("");
      const [inProc, own, hidden] = done.out.split("\n");
      expect(inProc).toBe(own);
      expect(hidden).toBe("outside-hidden");
    });
  },
);
