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
  const { mounts, cwd } = agentMounts(agent, home);
  return run(
    sandboxArgs({
      home,
      path: path(),
      mounts,
      socket: socketPath,
      cwd,
      command: ["sh", "-c", script],
    }),
  );
}

function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!done.success) throw new Error(done.stderr.toString());
  return done.stdout.toString().trim();
}

// A repository with one commit and a thread's worktree in .skel/worktrees/<issue>.
function repository(issue: number) {
  const repo = join(home, "code", "app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
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

  test("a builder commits in its worktree but can't change git's settings or hooks", async () => {
    const { repo, worktree } = repository(12);
    const other = join(repo, ".skel", "worktrees", "13");
    git(repo, "worktree", "add", "-q", "-b", "skel/13", other);
    const done = await inside(
      { kind: "builder", repository: repo, worktree },
      [
        "echo fix > fix && git add fix && git -c user.email=a@b -c user.name=A commit -qm fix && echo committed",
        `echo x >> ${repo}/.git/config || echo config-fixed`,
        `echo x > ${repo}/.git/hooks/pre-push || echo hooks-fixed`,
        `echo x > ${repo}/.git/worktrees/12/config.worktree || echo worktree-config-fixed`,
        `ls -A ${repo}/.skel/worktrees`,
      ].join("; "),
    );
    expect(done.out).toBe("committed\nconfig-fixed\nhooks-fixed\nworktree-config-fixed\n12\n");
    expect(git(worktree, "log", "-1", "--format=%s")).toBe("fix");
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("x\n");
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(false);
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
