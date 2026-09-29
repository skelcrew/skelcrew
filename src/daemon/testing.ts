// Helpers the daemon's tests share: throwaway repositories, and a raw
// connection to a socket that sends and reads lines.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A folder with .skelcrew/workflow.yml, removed by cleanUp. The prefix is
// short, so the socket fits in .skelcrew/.
export function throwawayRepo(dirs: string[], name = ""): string {
  const top = mkdtempSync(join(tmpdir(), "sk-"));
  dirs.push(top);
  const repo = name === "" ? top : join(top, name);
  mkdirSync(join(repo, ".skelcrew"), { recursive: true });
  writeFileSync(join(repo, ".skelcrew", "workflow.yml"), 'checks:\n  - "true"\n');
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
