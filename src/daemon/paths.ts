// Where a repository's daemon keeps its files. The daemon and the client
// both ask here, so they always agree on the socket.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DaemonPaths = {
  folder: string;
  workflow: string;
  store: string;
  socket: string;
};

// macOS refuses a socket path longer than this. Linux allows 107.
const MAX_SOCKET_PATH = 103;

// Paths start from the repository's real path, so a repository reached
// through a link gets the same socket as the daemon sees.
export function daemonPaths(
  repo: string,
): { ok: true; paths: DaemonPaths } | { ok: false; message: string } {
  let real: string;
  try {
    real = realpathSync(repo);
  } catch {
    return { ok: false, message: `The folder ${repo} doesn't exist.` };
  }
  const folder = join(real, ".skelcrew");
  let socket = join(folder, "daemon.sock");
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
    socket = join(realpathSync(tmpdir()), `skelcrew-${hash}.sock`);
  }
  return {
    ok: true,
    paths: {
      folder,
      workflow: join(folder, "workflow.yml"),
      store: join(folder, "skelcrew.db"),
      socket,
    },
  };
}
