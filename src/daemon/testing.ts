// Helpers the daemon's tests share: throwaway repositories, and a raw
// connection to a socket that sends and reads lines.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToStart, AgentUsage, Harness, Launch } from "../plugins/harness";
import type { SessionEnd, SessionRunner, SessionStart } from "../plugins/session-runner";
import type { Done } from "../plugins/version-control";

// A git repository with one commit on main and .skelcrew/workflow.yml,
// removed by cleanUp. The prefix is short, so the socket fits in
// .skelcrew/.
export function throwawayRepo(dirs: string[], name = ""): string {
  const top = mkdtempSync(join(tmpdir(), "sk-"));
  dirs.push(top);
  const repo = name === "" ? top : join(top, name);
  mkdirSync(join(repo, ".skelcrew"), { recursive: true });
  // Background runs off: a test never starts a real agent.
  writeFileSync(
    join(repo, ".skelcrew", "workflow.yml"),
    'checks:\n  - "true"\nbackground: false\n',
  );
  const git = (...args: string[]) => {
    const ran = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=t@t", ...args], {
      cwd: repo,
    });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "First");
  return repo;
}

// A daemon in a process of its own, returned once it listens. Killing it
// with SIGKILL leaves its lock and socket file behind, like a crash.
export async function daemonInAnotherProcess(repo: string) {
  const script = `
    import { serve } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
    const served = await serve(process.env.REPO);
    if (!served.ok) { console.error(served.message); process.exit(1); }
    console.log("ready");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, REPO: repo },
    stdout: "pipe",
    stderr: "inherit",
  });
  const first = await child.stdout.getReader().read();
  const said = new TextDecoder().decode(first.value);
  if (!said.includes("ready")) throw new Error(`The daemon didn't start: ${said}`);
  return child;
}

// Root ignores file permissions, so tests that make a file or folder
// read-only would test nothing. They are skipped when running as root.
export const asRoot = process.getuid?.() === 0;

export function cleanUp(dirs: string[]): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export type Line = {
  send(text: string): void;
  // The next whole line the other side sent, without its newline.
  next(): Promise<string>;
  // Resolves once the other side closes the connection.
  closed: Promise<void>;
  close(): void;
};

export function openLine(path: string): Promise<Line> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path);
    socket.setEncoding("utf8");
    const lines: string[] = [];
    const waiting: ((line: string) => void)[] = [];
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const wake = waiting.shift();
        if (wake === undefined) lines.push(line);
        else wake(line);
        end = buffer.indexOf("\n");
      }
    });
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.on("error", reject);
    socket.on("connect", () =>
      resolve({
        send: (text) => socket.write(text),
        next: () => {
          const line = lines.shift();
          if (line !== undefined) return Promise.resolve(line);
          return new Promise((wake) => waiting.push(wake));
        },
        closed,
        close: () => socket.end(),
      }),
    );
  });
}

// A runner that runs nothing. It records what it was asked to do, and a
// test ends a session with `end`, as a crash or an exit would.
export class FakeRunner implements SessionRunner {
  readonly canStepIn = false;
  readonly started: SessionStart[] = [];
  readonly typed: { name: string; text: string }[] = [];
  readonly stopped: string[] = [];
  private readonly open = new Set<string>();
  private readonly listeners: ((name: string, end: SessionEnd) => void)[] = [];

  async start(session: SessionStart): Promise<Done<null>> {
    if (this.open.has(session.name)) return { ok: true, value: null };
    this.started.push(session);
    this.open.add(session.name);
    return { ok: true, value: null };
  }

  async type(name: string, text: string): Promise<Done<null>> {
    if (!this.open.has(name)) return { ok: false, message: `${name} isn't running.` };
    this.typed.push({ name, text });
    return { ok: true, value: null };
  }

  async stop(name: string): Promise<Done<null>> {
    this.stopped.push(name);
    this.end(name, { exitCode: null, lastLine: "" });
    return { ok: true, value: null };
  }

  async running(): Promise<Done<string[]>> {
    return { ok: true, value: [...this.open] };
  }

  onEnd(listener: (name: string, end: SessionEnd) => void): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {}

  // Ends a session, as an exit or a crash would.
  end(name: string, end: SessionEnd): void {
    if (!this.open.delete(name)) return;
    for (const listener of this.listeners) listener(name, end);
  }
}

// A harness whose command is only a description, for the fake runner.
export class FakeHarness implements Harness {
  readonly name = "fake";

  launch(agent: AgentToStart): Launch {
    return {
      command: ["fake-agent", agent.kind, String(agent.taskId)],
      env: { SKELCREW_SESSION: agent.session },
      harnessSession: `fake-${agent.session}`,
    };
  }

  async usage(): Promise<Done<AgentUsage>> {
    return { ok: true, value: { tokens: 0, cacheReads: 0, workingMs: 0 } };
  }
}
