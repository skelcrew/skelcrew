// Which Skelcrew this is: the release, or the commit of a build from a checkout, as stamped in
// when it was built. sc --version and the sidebar's header show it, and --remote compares it.
// Also where this Skelcrew lives on disk. Only this file works that out, so moving a source file
// can't break a second copy.
import { join, resolve } from "node:path";
import { z } from "zod";

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

// Returns the version the checkout's package.json gives, or nothing when it can't be found.
// A require that can fail rather than an import: Bun finds the file by listing its folder,
// and on a Mac an agent's sandbox lets it open the checkout's files but not list the
// checkout, so an import there stopped every sc command an agent ran. Agents never draw the
// header, so nothing is right for them. A single-file build carries the file inside itself.
function checkoutVersion(): string {
  try {
    return z.object({ version: z.string() }).parse(require("../package.json")).version;
  } catch {
    return "";
  }
}

// The version the header shows: the release, or for a build from a checkout, the version its
// package.json gives, so a screenshot always says which Skelcrew it came from.
export const version = release || checkoutVersion();

// Where releases live, stamped in by the release build from the install script, the one place
// that says so.
declare const SKELCREW_RELEASES: string;
export const releases = typeof SKELCREW_RELEASES === "string" ? SKELCREW_RELEASES : "";

// Added after the commit of a build with uncommitted changes. Such a build can't say what it
// holds, so it never counts as up to date.
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
