// The sandbox around every agent, run for real with bubblewrap, under a home folder of the
// test's own so nothing touches your real ~/.claude.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
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
import { type Agent, agentCommand, agentMounts, checkGitDir, sandboxArgs } from "../src/sandbox.ts";

let home = "";
let socket: ReturnType<typeof Bun.listen> | undefined;
let socketPath = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-sandbox-test-")));
  writeFileSync(join(home, ".gitconfig"), "[user]\n  name = Simon\n  email = simon@example.com\n");
  socketPath = join(home, "agent.sock");
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

// Runs a shell script inside the sandbox an agent of this kind gets.
function inside(agent: Agent, script: string) {
  const { mounts, env, cwd } = agentMounts(agent, home);
  return run(
    sandboxArgs({
      home,
      path: path(),
      mounts,
      env,
      socket: socketPath,
      cwd,
      command: ["sh", "-c", script],
    }),
    { ...process.env, HOME: home },
  );
}

// Git as you run it outside, with your name in the test home's ~/.gitconfig.
function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return done.stdout.toString().trim();
}

// A repository with one commit and a thread's worktree in .skel/worktrees/<issue>.
function repository(issue: number) {
  const repo = join(home, "code", "app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README"), "app\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "start");
  const worktree = join(repo, ".skel", "worktrees", String(issue));
  git(repo, "worktree", "add", "-q", "-b", `skel/${issue}`, worktree);
  return { repo, worktree };
}

describe("checkGitDir", () => {
  test("passes a plain repository", () => {
    const { repo } = repository(12);
    expect(() => checkGitDir(repo)).not.toThrow();
  });

  test("refuses links, stray locks and alternates that would steer git outside", () => {
    const { repo } = repository(12);
    const dotgit = join(repo, ".git");
    mkdirSync(join(home, "ssh"));
    const traps: [string, () => void][] = [
      [
        join(dotgit, "refs", "remotes", "origin"),
        () => {
          mkdirSync(join(dotgit, "refs", "remotes"), { recursive: true });
          symlinkSync(join(home, "ssh"), join(dotgit, "refs", "remotes", "origin"));
        },
      ],
      [
        join(dotgit, "objects", "pack"),
        () => {
          rmSync(join(dotgit, "objects", "pack"), { recursive: true, force: true });
          symlinkSync(join(home, "ssh"), join(dotgit, "objects", "pack"));
        },
      ],
      [
        join(dotgit, "refs", "heads", "main.lock"),
        () => {
          writeFileSync(join(dotgit, "refs", "heads", "main.lock"), "");
        },
      ],
      [
        join(dotgit, "packed-refs"),
        () => {
          rmSync(join(dotgit, "packed-refs"), { force: true });
          symlinkSync(join(home, "ssh", "x"), join(dotgit, "packed-refs"));
        },
      ],
      [
        join(dotgit, "objects", "info", "alternates"),
        () => {
          mkdirSync(join(dotgit, "objects", "info"), { recursive: true });
          writeFileSync(join(dotgit, "objects", "info", "alternates"), "/elsewhere\n");
        },
      ],
    ];
    for (const [path, plant] of traps) {
      const keep = join(home, "keep");
      rmSync(keep, { recursive: true, force: true });
      Bun.spawnSync(["cp", "-a", dotgit, keep]);
      plant();
      expect(() => checkGitDir(repo)).toThrow(path);
      rmSync(dotgit, { recursive: true, force: true });
      Bun.spawnSync(["mv", keep, dotgit]);
    }
  });
});

// bubblewrap can't start inside skel's own sandbox, so only there these tests can't run.
describe.skipIf(process.env.SKEL_SANDBOX === "1")("sandbox", () => {
  test("the lead writes in its folder and nowhere else", async () => {
    const { repo } = repository(1);
    const lead = join(home, ".local", "share", "skel", "lead");
    const done = await inside(
      { kind: "lead", repositories: [repo] },
      `pwd; echo hi > note && cat note; cat ${repo}/README; echo x > ${repo}/new; echo x > /usr/new; echo x > /tmp/ok && echo tmp-ok`,
    );
    expect(done.out).toBe(`${lead}\nhi\napp\ntmp-ok\n`);
    expect(done.err).toContain("Read-only file system");
    expect(readFileSync(join(lead, "note"), "utf8")).toBe("hi\n");
    expect(existsSync(join(repo, "new"))).toBe(false);
  });

  test("hides the home folder's secrets and the other sockets in /run", async () => {
    const { repo } = repository(1);
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: secret\n");
    const done = await inside(
      { kind: "lead", repositories: [repo] },
      `test -e ${home}/.config/gh/hosts.yml || echo hidden; ls /run; ls /run/systemd; test -S /run/skel.sock && echo socket; echo $SKEL_SANDBOX`,
    );
    expect(done.out).toBe("hidden\nskel.sock\nsystemd\nresolve\nsocket\n1\n");
  });

  test("a builder commits, amends, rebases and merges in its worktree, as you", async () => {
    const { repo, worktree } = repository(12);
    writeFileSync(join(repo, "MAIN"), "main\n");
    git(repo, "add", "MAIN");
    git(repo, "commit", "-qm", "main moved");
    const done = await inside(
      { kind: "builder", repository: repo, worktree },
      [
        "set -e",
        "echo fix > fix && git add fix && git commit -qm fix",
        "git commit -q --amend -m 'fix it'",
        "git rebase -q main",
        "git checkout -q -b side && echo s > side && git add side && git commit -qm side",
        "git checkout -q skel/12 && git merge -q --no-edit side",
        "echo done",
      ].join("\n"),
    );
    expect(done.err).toBe("");
    expect(done.out).toBe("done\n");
    expect(git(worktree, "log", "-3", "--format=%s %an %cn")).toBe(
      "side Simon Simon\nfix it Simon Simon\nmain moved Simon Simon",
    );
  });

  test("a builder can't change git's settings or hooks, nor point git at its own", async () => {
    const { repo, worktree } = repository(12);
    const other = join(repo, ".skel", "worktrees", "13");
    git(repo, "worktree", "add", "-q", "-b", "skel/13", other);
    const pwned = join(home, "pwned");
    const admin = join(repo, ".git", "worktrees");
    // Each route points git at a folder whose config runs a command whenever git runs.
    const done = await inside(
      { kind: "builder", repository: repo, worktree },
      [
        `mkdir -p evil && cp -r ${repo}/.git/refs ${repo}/.git/HEAD evil/ 2>/dev/null`,
        `printf '[core]\\n  fsmonitor = touch ${pwned}\\n' > evil/config`,
        `echo x >> ${repo}/.git/config || echo config-fixed`,
        `echo x > ${repo}/.git/hooks/pre-push || echo hooks-fixed`,
        `echo $PWD/evil > ${repo}/.git/commondir`,
        `echo $PWD/evil > ${admin}/13/commondir || echo other-fixed`,
        `echo $PWD/evil > ${admin}/12/commondir || echo own-fixed`,
        `echo x > ${admin}/12/config.worktree || echo worktree-config-fixed`,
        `mv ${admin}/12 ${admin}/12x || echo rename-fixed`,
        `ls -A ${repo}/.skel/worktrees`,
      ].join("; "),
    );
    expect(done.out).toBe(
      "config-fixed\nhooks-fixed\nother-fixed\nown-fixed\nworktree-config-fixed\nrename-fixed\n12\n",
    );
    for (const at of [repo, worktree, other]) git(at, "status");
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(join(repo, ".git", "commondir"))).toBe(false);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(false);
  });

  test("a builder can't make git outside write through its links, or borrow objects", async () => {
    const { repo, worktree } = repository(12);
    git(home, "init", "-q", "--bare", "remote.git");
    git(repo, "remote", "add", "origin", join(home, "remote.git"));
    const victim = join(home, "victim");
    writeFileSync(victim, "safe\n");
    const dotgit = join(repo, ".git");
    const done = await inside(
      { kind: "builder", repository: repo, worktree },
      [
        "echo f > f && git add f && git commit -qm f",
        `mkdir -p ${dotgit}/logs/refs/remotes/origin/skel`,
        `ln -s ${victim} ${dotgit}/logs/refs/remotes/origin/skel/12`,
        `echo /etc > ${dotgit}/objects/info/alternates || echo alternates-fixed`,
        `echo /etc > ${dotgit}/objects/info/http-alternates || echo http-alternates-fixed`,
        `mv ${dotgit}/objects/info ${dotgit}/objects/info.moved || echo info-fixed`,
        `mkdir -p ${dotgit}/objects/info`,
        `echo /etc > ${dotgit}/objects/info/alternates || echo still-fixed`,
      ].join("; "),
    );
    expect(done.out).toBe("alternates-fixed\nhttp-alternates-fixed\ninfo-fixed\nstill-fixed\n");
    // As the daemon pushes: in the main repository, by the commit it recorded.
    const sha = git(repo, "rev-parse", "skel/12");
    git(repo, "push", "-q", "origin", `${sha}:refs/heads/skel/12`);
    expect(readFileSync(victim, "utf8")).toBe("safe\n");
    expect(existsSync(join(dotgit, "objects", "info", "alternates"))).toBe(false);
    expect(existsSync(join(dotgit, "objects", "info.moved"))).toBe(false);
  });

  test("the lead can't see threads that start after it", async () => {
    const site = join(home, "code", "site");
    mkdirSync(site, { recursive: true });
    git(site, "init", "-q");
    const seen = inside({ kind: "lead", repositories: [site] }, `sleep 1; ls -A ${site}/.skel`);
    await Bun.sleep(300);
    mkdirSync(join(site, ".skel", "worktrees", "9"), { recursive: true });
    expect((await seen).out).toBe("");
  });

  test("refuses a repository whose git config holds a credential", () => {
    const { repo, worktree } = repository(12);
    const credentials: [string, string][] = [
      ["remote.origin.url", "https://simon:ghp_secret@github.com/simon/app"],
      ["http.https://github.com/.extraheader", "AUTHORIZATION: basic c2VjcmV0"],
    ];
    for (const [key, value] of credentials) {
      git(repo, "config", key, value);
      for (const agent of [
        { kind: "lead" as const, repositories: [repo] },
        { kind: "builder" as const, repository: repo, worktree },
      ])
        expect(() => agentMounts(agent, home)).toThrow("gh");
      git(repo, "config", "--unset", key);
    }
    expect(() => agentMounts({ kind: "builder", repository: repo, worktree }, home)).not.toThrow();
  });

  test("finds a worktree's git folder when git wrote it as a relative path", async () => {
    const { repo, worktree } = repository(12);
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/12\n");
    const done = await inside(
      { kind: "builder", repository: repo, worktree },
      "echo f > f && git add f && git commit -qm f && echo committed",
    );
    expect(done.out).toBe("committed\n");
  });

  test("a reviewer can't write in the worktree", async () => {
    const { repo, worktree } = repository(12);
    const done = await inside(
      { kind: "reviewer", repository: repo, worktree },
      "cat README; echo x > new || echo refused",
    );
    expect(done.out).toBe("app\nrefused\n");
    expect(existsSync(join(worktree, "new"))).toBe(false);
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

  test("Claude Code starts in its own config folder, trusted, with skel's token", async () => {
    const { repo, worktree } = repository(12);
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
      agent: { kind: "builder", repository: repo, worktree },
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
        "SKEL_SOCKET=/run/skel.sock",
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
    expect(JSON.parse(readFileSync(json, "utf8")).projects[worktree].hasTrustDialogAccepted).toBe(
      true,
    );
    expect(statSync(json).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(config, "note"), "utf8")).toBe("m\n");
    expect(yours()).toBe(before);
  });

  test("each session gets a config folder of its own", async () => {
    const { repo, worktree } = repository(12);
    saveToken();
    fakeClaude(["ls -A ~/.local/share/skel/claude"]);
    const builder = agentCommand({
      agent: { kind: "builder", repository: repo, worktree },
      name: "app-12",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    const reviewer = agentCommand({
      agent: { kind: "reviewer", repository: repo, worktree },
      name: "app-12-review-1",
      socket: socketPath,
      model: "opus",
      env: outside(),
    });
    expect(builder.env.CLAUDE_CONFIG_DIR).not.toBe(reviewer.env.CLAUDE_CONFIG_DIR);
    expect((await run(reviewer.argv, reviewer.env)).out).toBe("app-12-review-1\n");
  });

  test("won't write a session's settings through a link the agent left", () => {
    const { repo, worktree } = repository(12);
    saveToken();
    const start = () =>
      agentCommand({
        agent: { kind: "builder", repository: repo, worktree },
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
    const { repo, worktree } = repository(12);
    saveToken();
    const config = join(home, ".local", "share", "skel", "claude", "app-12");
    mkdirSync(config, { recursive: true });
    Bun.spawnSync(["mkfifo", join(config, ".claude.json")]);
    const script = `import { agentCommand } from ${JSON.stringify(join(import.meta.dir, "..", "src", "sandbox.ts"))};
agentCommand({ agent: { kind: "builder", repository: ${JSON.stringify(repo)}, worktree: ${JSON.stringify(worktree)} }, name: "app-12", socket: "x", model: "opus" });`;
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
        agent: { kind: "builder", repository: repo, worktree },
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("isn't a plain file");
  });

  test("starts a new session under the ID it is given, which must be a UUID", () => {
    const { repo, worktree } = repository(12);
    saveToken();
    const id = "6f1c2a7e-0b4d-4c3e-9a51-2d8e7f6a9b10";
    const start = (more: { sessionId?: string; resume?: string }) =>
      agentCommand({
        agent: { kind: "builder", repository: repo, worktree },
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

  test("says to run skel first when there is no token", () => {
    const { repo, worktree } = repository(12);
    expect(() =>
      agentCommand({
        agent: { kind: "builder", repository: repo, worktree },
        name: "app-12",
        socket: socketPath,
        model: "opus",
        env: outside(),
      }),
    ).toThrow("run skel");
  });
});
