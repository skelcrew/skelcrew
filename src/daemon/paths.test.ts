import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPaths } from "./paths";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function paths(repo: string) {
  const found = daemonPaths(repo);
  if (!found.ok) throw new Error(found.message);
  return found.paths;
}

describe("daemonPaths", () => {
  test("keeps the socket in .skelcrew/ when its path is short enough", () => {
    const repo = realpathSync(folder("sk-"));
    expect(paths(repo)).toEqual({
      folder: join(repo, ".skelcrew"),
      workflow: join(repo, ".skelcrew", "workflow.yml"),
      store: join(repo, ".skelcrew", "skelcrew.db"),
      lock: join(repo, ".skelcrew", "daemon.lock"),
      socket: join(repo, ".skelcrew", "daemon.sock"),
    });
  });

  // macOS refuses a socket path over 103 bytes, so a deep repository gets
  // a short socket in the temp folder instead.
  test("puts the socket in the temp folder when the repository's path is long", () => {
    const repo = join(folder("sk-"), "a-folder-with-a-rather-long-name".repeat(3));
    mkdirSync(repo);
    const socket = paths(repo).socket;
    expect(socket.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    expect(paths(repo).socket).toBe(socket);
  });

  test("gives two long repositories different sockets", () => {
    const long = "a-folder-with-a-rather-long-name".repeat(3);
    const one = join(folder("sk-"), long);
    const two = join(folder("sk-"), long);
    mkdirSync(one);
    mkdirSync(two);
    expect(paths(one).socket).not.toBe(paths(two).socket);
  });

  // The CLI may find the repository through a link, and the daemon through
  // its real path. Both must reach the same socket.
  test("gives the same paths for a repository reached through a link", () => {
    const repo = join(folder("sk-"), "a-folder-with-a-rather-long-name".repeat(3));
    mkdirSync(repo);
    const link = join(folder("sk-"), "link");
    symlinkSync(repo, link);
    expect(paths(link)).toEqual(paths(repo));
  });

  test("says so when the repository folder doesn't exist", () => {
    const found = daemonPaths(join(folder("sk-"), "missing"));
    expect(found.ok).toBe(false);
  });
});
