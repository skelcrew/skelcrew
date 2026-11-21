// Which Skelcrew this is, and where it lives on disk: its release or checkout commit, and the
// labels sc --version, the screen's header and the list's top line show for it.
import { join, resolve } from "node:path";

declare const SKELCREW_BUILD: string;
export const built = typeof SKELCREW_BUILD === "string" ? SKELCREW_BUILD : undefined;

export const isRelease = (build: string) => /^\d+\.\d+\.\d+$/.test(build);

export const release = built !== undefined && isRelease(built) ? built : "";

declare const SKELCREW_RELEASES: string;
export const releases = typeof SKELCREW_RELEASES === "string" ? SKELCREW_RELEASES : "";

export const dirty = "-dirty";

export const readable = (build: string) =>
  build.endsWith(dirty) ? `${build.slice(0, -dirty.length)} with uncommitted changes` : build;

export const singleFile = import.meta.dir.startsWith("/$bunfs");

export const checkoutFolder = resolve(import.meta.dir, "..");
export const mainFile = join(checkoutFolder, "src", "main.ts");
export const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", checkoutFolder, ...args], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();

export function checkoutBuild(): string | null {
  if (singleFile) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  if (commit === "") return null;
  return git("status", "--porcelain") === "" ? commit : `${commit}${dirty}`;
}

function checkoutLabels(build: string | null): string[] {
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

let shown: string[] = [];
export function versionLabels(): string[] {
  if (release) return [`v${release}`];
  if (shown.length === 0) shown = checkoutLabels(built ?? checkoutBuild());
  return shown;
}

export function versionLine(): string {
  if (release) return `skelcrew ${release}`;
  return `Skelcrew ${checkoutLabels(built ?? checkoutBuild())[0]}`;
}
