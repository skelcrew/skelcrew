// Which skel this is: the release, or the commit of a build from a checkout, as stamped in when
// it was built. skel --version and the sidebar's header say it, and --remote compares it.
import { resolve } from "node:path";

// What skel was built from. The release build stamps its release, such as 0.4.2, and
// withLinuxSkel the commit of the copy it builds for a server or Sprite. A skel run from a
// checkout has none, and updates with git pull.
declare const SKEL_BUILD: string;
export const built = typeof SKEL_BUILD === "string" ? SKEL_BUILD : undefined;

// The release this skel is, or nothing for a build from a checkout. A commit has no dots, so
// the stamp can't be mistaken.
export const release = built !== undefined && /^\d+\.\d+\.\d+$/.test(built) ? built : "";

// Follows the commit of a build made with changes not committed. Such a build can't say
// what it holds, so it never counts as up to date.
export const dirty = "-dirty";

// Returns a build as people read it.
export const readable = (build: string) =>
  build.endsWith(dirty) ? `${build.slice(0, -dirty.length)} with uncommitted changes` : build;

// The checkout this skel runs from on the laptop, and git in it.
export const checkoutFolder = resolve(import.meta.dir, "..");
export const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", checkoutFolder, ...args], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();

// Returns the build a copy made from this checkout gets: its commit, marked when changes
// aren't committed, or null when skel doesn't run from a checkout.
export function laptopBuild(): string | null {
  // A single-file skel runs its modules from a folder only it sees, outside any checkout.
  if (import.meta.dir.startsWith("/$bunfs")) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  if (commit === "") return null;
  return git("status", "--porcelain") === "" ? commit : `${commit}${dirty}`;
}

// Returns what skel --version prints: the release, or, for anything else, that this is a build
// from a checkout, so nobody reports a bug against a release they don't have.
export function versionLine(): string {
  if (release) return `skel ${release}`;
  const build = built ?? laptopBuild();
  return `skel from a checkout, at ${build ? `commit ${readable(build)}` : "an unknown commit"}`;
}
