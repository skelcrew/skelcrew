// Where a repository's daemon keeps its files. The daemon and the client
// both ask here, so they always agree on the socket.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";

export type DaemonPaths = {
  folder: string;
  workflow: string;
  store: string;
  socket: string;
  // Where the socket goes when it can't go in .skelcrew/: a folder in /tmp
  // for this user alone, which the daemon makes. Null when it fits.
  sharedSocketFolder: string | null;
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
  let sharedSocketFolder: string | null = null;
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    // A fixed folder, not the temp folder, which can differ between two
    // shells of the same user. The user id keeps users apart.
    const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
    sharedSocketFolder = `/tmp/skelcrew-${process.getuid?.() ?? "user"}`;
    socket = join(sharedSocketFolder, `${hash}.sock`);
  }
  return {
    ok: true,
    paths: {
      folder,
      workflow: join(folder, "workflow.yml"),
      store: join(folder, "skelcrew.db"),
      socket,
      sharedSocketFolder,
    },
  };
}
