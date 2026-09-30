// Where a git repository starts: the folder that holds its .git. Skelcrew
// runs only there. From a folder inside a repository, git's worktrees and
// merges would still cover the whole repository, which isn't supported.
//
// `skelcrew init` uses this. The daemon has its own copy of the check for
// now, in mainBranch in src/daemon/server.ts, and can switch to this one.

import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

export type Top = { ok: true; top: string } | { ok: false; message: string };

// The real path of the top of the git repository that holds the folder.
// It fails with a message when git isn't installed, or when the folder
// isn't in a git repository.
export function repositoryTop(folder: string): Top {
  let ran: { exitCode: number; stdout: Buffer };
  try {
    ran = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: folder,
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    // Starting a program that isn't installed throws.
    return { ok: false, message: "Skelcrew needs git, and couldn't find it." };
  }
  if (ran.exitCode !== 0) {
    return { ok: false, message: `${folder} isn't a git repository. Skelcrew needs one.` };
  }
  return { ok: true, top: realpathSync(ran.stdout.toString().trim()) };
}

// What Skelcrew says when it is asked to run in a folder inside a
// repository instead of where the repository starts.
export function insideRepository(folder: string, top: string): string {
  return `${folder} is inside the git repository at ${top}. Run Skelcrew there, where the repository starts.`;
}

// The real path of the repository's main folder, the one Skelcrew runs in,
// even from inside one of its worktrees. A task's worktree holds its own
// copy of .skelcrew/, so going by the nearest .skelcrew/ would find the
// worktree instead. git's shared folder (`.git` of the main folder) says
// where the main folder is.
export function mainRepository(folder: string): Top {
  const top = repositoryTop(folder);
  if (!top.ok) return top;
  const ran = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: folder,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (ran.exitCode !== 0) return top;
  const shared = ran.stdout.toString().trim();
  // A repository with no main folder, only its .git, keeps the top.
  if (basename(shared) !== ".git") return top;
  return { ok: true, top: realpathSync(dirname(shared)) };
}
