// Which Skelcrew this is: the release, or the commit of a build from a checkout, as stamped in when
// it was built. sc --version and the sidebar's header say it, and --remote compares it. Also
// where this Skelcrew lives, worked out only here, as a moved source file would quietly break any
// second copy of that.
import { join, resolve } from "node:path";

// What Skelcrew was built from. The release build stamps its release, such as 0.4.2, and
// withLinuxSkel the commit of the copy it builds for a server or Sprite. A Skelcrew run from a
// checkout has none, and updates with git pull.
declare const SKELCREW_BUILD: string;
export const built = typeof SKELCREW_BUILD === "string" ? SKELCREW_BUILD : undefined;

// Says whether a build is a release, such as 0.4.2. A commit has no dots, so the two can't be
// mistaken.
export const isRelease = (build: string) => /^\d+\.\d+\.\d+$/.test(build);

// The release this Skelcrew is, or nothing for a build from a checkout.
export const release = built !== undefined && isRelease(built) ? built : "";

// Where releases live, stamped in by the release build from the install script, the one place
// that says so.
declare const SKELCREW_RELEASES: string;
export const releases = typeof SKELCREW_RELEASES === "string" ? SKELCREW_RELEASES : "";

// Follows the commit of a build made with changes not committed. Such a build can't say
// what it holds, so it never counts as up to date.
export const dirty = "-dirty";

// Returns a build as people read it.
export const readable = (build: string) =>
  build.endsWith(dirty) ? `${build.slice(0, -dirty.length)} with uncommitted changes` : build;

// Whether this Skelcrew is a single file, built with bun build --compile. Such a Skelcrew runs its
// modules from a folder only it sees, so it has no sources or checkout on disk.
export const singleFile = import.meta.dir.startsWith("/$bunfs");

// The checkout this Skelcrew runs from, the file that starts Skelcrew in it, and git in it. A
// single file has no checkout, so the paths mean nothing there: check singleFile first.
export const checkoutFolder = resolve(import.meta.dir, "..");
export const mainFile = join(checkoutFolder, "src", "main.ts");
export const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", checkoutFolder, ...args], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();

// Returns the build a copy made from this checkout gets: its commit, marked when changes
// aren't committed, or null when Skelcrew doesn't run from a checkout.
export function laptopBuild(): string | null {
  // A single-file Skelcrew runs its modules from a folder only it sees, outside any checkout.
  if (singleFile) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  if (commit === "") return null;
  return git("status", "--porcelain") === "" ? commit : `${commit}${dirty}`;
}

// Returns what sc --version prints: the release, or, for anything else, that this is a build
// from a checkout, so nobody reports a bug against a release they don't have.
export function versionLine(): string {
  // installLatest reads a release back from this line, so its shape matters.
  if (release) return `skelcrew ${release}`;
  const build = built ?? laptopBuild();
  return `skelcrew from a checkout, at ${build ? `commit ${readable(build)}` : "an unknown commit"}`;
}
