// Which Skelcrew this is: the release, or the commit of a build from a checkout, as stamped in
// when it was built or read from the checkout. sc --version, the screen's header and the list's
// top line show it, and --remote compares it.
// Also where this Skelcrew lives on disk. Only this file works that out, so moving a source file
// can't break a second copy.
import { join, resolve } from "node:path";

// What Skelcrew was built from. The release build stamps its release, such as 0.4.2, and
// withLinuxSkel the commit of the copy it builds for a server. A Skelcrew run from a checkout
// has none, and updates with git pull.
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

// Returns how a build from a checkout is named after "Skelcrew": its commit, such as
// 6f1c2ab (checkout), with a * that the name explains when it held uncommitted changes, which
// sc --version and the list show, then shorter names for
// the sidebar's header, which has room for only 24 columns. Each shorter one drops words around
// the commit, never a character of it, as git gives as many as it takes to name one commit, and
// more in a repository with many. With changes, +changes or at least the * always stays, as the
// commit alone would look like a clean checkout. A build with no commit to name, such as a single file nobody
// stamped, says so rather than pretending.
function checkoutNames(build: string | null): string[] {
  if (build === null) return ["(checkout, commit unknown)", "checkout, commit unknown"];
  if (build.endsWith(dirty)) {
    const commit = build.slice(0, -dirty.length);
    return [
      `${commit}* (checkout, * = uncommitted changes)`,
      `checkout ${commit}+changes`,
      `${commit}+changes`,
      `${commit}*`,
    ];
  }
  return [`${build} (checkout)`, build];
}

// Returns which Skelcrew this is, as the screen's header and the list's top line show it after
// "Skelcrew": the release, such as v0.4.2, or a checkout's commit, so a screenshot always says
// which Skelcrew it came from. The longest name comes first, then any shorter ones. The checkout
// is read once, with the same git commands the engine uses to decide when to restart, as the
// code that runs doesn't change after it starts. Only when asked, so commands that never draw,
// such as an agent's sc submit, don't run git for it.
let shown: string[] = [];
export function shownVersions(): string[] {
  if (release) return [`v${release}`];
  if (shown.length === 0) shown = checkoutNames(built ?? laptopBuild());
  return shown;
}

// Returns what sc --version prints: the release, or, for anything else, that this is a build
// from a checkout and its commit, so nobody reports a bug against a release they don't have.
export function versionLine(): string {
  // installLatest and the release workflow read a release back from this line, so its shape
  // matters. The workflow checks for this lowercase skelcrew, so it stays until the workflow
  // changes with it.
  if (release) return `skelcrew ${release}`;
  return `Skelcrew ${checkoutNames(built ?? laptopBuild())[0]}`;
}
