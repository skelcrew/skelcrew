// The sandbox around every agent, run for real with bubblewrap, under a home folder of the
// test's own so nothing touches your real ~/.claude.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, agentCommand, agentMounts, sandboxArgs } from "../src/sandbox.ts";

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

  test("Claude Code starts trusted, with your setup read-only and its own sandbox off", async () => {
    const { repo, worktree } = repository(12);
    const claude = join(home, ".claude");
    mkdirSync(join(claude, "hooks"), { recursive: true });
    writeFileSync(join(claude, "settings.json"), "{}\n");
    const original = `${JSON.stringify({ projects: { "/x": { hasTrustDialogAccepted: false } } })}\n`;
    writeFileSync(join(home, ".claude.json"), original);
    mkdirSync(join(home, "bin"));
    // Stands in for Claude Code: reports what it was given and what it may change.
    writeFileSync(
      join(home, "bin", "claude"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@"',
        "env | grep -E '^(CLAUDE_CODE_|SKEL_|GH_TOKEN|TERM)' | sort",
        "cat ~/.claude.json; echo",
        "echo t > ~/.claude/projects-note && echo shared",
        "echo x > ~/.claude/settings.json || echo settings-fixed",
        "echo x > ~/.claude/hooks/new || echo hooks-fixed",
        "echo x > ~/.claude/CLAUDE.md || echo claude-md-fixed",
        "true",
      ].join("\n"),
      { mode: 0o755 },
    );
    const { argv, env } = agentCommand({
      agent: { kind: "builder", repository: repo, worktree },
      name: "app-12",
      socket: socketPath,
      model: "opus",
      prompt: "Fix the bug",
      resume: "abc-123",
      env: {
        HOME: home,
        PATH: path(),
        TERM: "xterm",
        CLAUDE_CODE_CHILD_SESSION: "1",
        GH_TOKEN: "secret",
        SKEL_GITHUB_APP_KEY: "secret",
      },
    });
    const done = await run(argv, env);
    expect(done.code).toBe(0);
    const json = done.out.split("\n").find((line) => line.startsWith('{"projects"')) ?? "";
    expect(done.out.split(json)[0]).toBe(
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
        "SKEL_SANDBOX=1",
        "SKEL_SOCKET=/run/skel.sock",
        "TERM=xterm",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(json).projects[worktree].hasTrustDialogAccepted).toBe(true);
    expect(done.out).toEndWith("shared\nsettings-fixed\nhooks-fixed\nclaude-md-fixed\n");
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(original);
    expect(readFileSync(join(claude, "projects-note"), "utf8")).toBe("t\n");
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe("{}\n");
  });
});
