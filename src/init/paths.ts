// Whether a file init writes would land outside the repository. Some
// people link a repository's .claude folder to their own ~/.claude, or its
// .agents folder to their own ~/.agents. Init would then write its rules
// into their own settings, or its skills into their own .agents/skills,
// which every other project reads too. So before init writes a file, it follows
// each link on the way to it and checks where it really leads.

import { lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

// The first part of the path that leads outside the repository, such as
// ".agents" for ".agents/skills/spec/SKILL.md" when .agents is a link to
// ~/.agents. Null when every part stays inside. A part that can't be
// checked, such as a link to nowhere, counts as outside, since init can't
// tell where a write would go.
export function outsideLink(dir: string, path: string): string | null {
  const root = realPath(dir);
  if (root === null) return path;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join("/");
    const kind = linkKind(join(dir, part));
    // Nothing is there yet, so init makes it, inside the repository.
    if (kind === "missing") return null;
    if (kind === "unknown") return part;
    if (kind === "link") {
      const real = realPath(join(dir, part));
      if (real === null || (real !== root && !real.startsWith(root + sep))) return part;
    }
  }
  return null;
}

// What init tells you when it leaves a file alone for this reason.
export function outsideWarning(path: string, link: string): string {
  return [
    `Init didn't write ${path}, because ${link} is a link to a place outside the repository, such as your own ${homeExample(link)}.`,
    "Writing there would change files other projects use too.",
    `To add it, make ${link} a real folder in the repository and run init again.`,
  ].join(" ");
}

// The usual place a link like this leads: ~/.agents for .agents or a
// folder inside it, and ~/.claude otherwise.
function homeExample(link: string): string {
  return link === ".agents" || link.startsWith(".agents/") ? `~/${link}` : "~/.claude";
}

function linkKind(path: string): "missing" | "link" | "other" | "unknown" {
  try {
    return lstatSync(path).isSymbolicLink() ? "link" : "other";
  } catch (error) {
    // ENOTDIR means a file stands where a folder should be. There is no
    // link to follow, and the write itself will fail and say so.
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unknown";
  }
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
