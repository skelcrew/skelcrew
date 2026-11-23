// The commit and push sc init offers of the files it wrote, with your own git, to the default
// branch, or to a branch and a pull request when the default branch refuses it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toRun } from "../format.ts";
import { dataDir } from "../paths.ts";
import { parseRemote } from "./origin.ts";
import { askLine } from "./pick.ts";

const message = "Set up Skelcrew";
const setupBranch = "skelcrew/setup";

function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

const yes = (question: string) =>
  ["", "y", "yes"].includes(askLine(`${question} [Y/n] `)?.toLowerCase() ?? "n");

const listed = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

function byHand(files: string[], target: string): void {
  const paths = files.join(" ");
  console.log(
    `To commit and push them yourself, run:\n${toRun([`git add -- ${paths}`, `git commit -m "${message}" -- ${paths}`, `git push origin HEAD:${target}`]).trimEnd()}`,
  );
}

function defaultBranch(root: string): string | null {
  const said = git(root, ["ls-remote", "--symref", "origin", "HEAD"]);
  return said.ok ? (/^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(said.out)?.[1] ?? null) : null;
}

async function openSetupPr(base: string, remote: string): Promise<string> {
  const fallback = `Open a pull request from ${setupBranch} into ${base} on your forge.`;
  const place = parseRemote(remote);
  if (!place || !existsSync(join(dataDir(), "skelcrew.db"))) return fallback;
  try {
    const { openDb } = await import("../db.ts");
    const { askWhichForge, openPr } = await import("../plugins/ask.ts");
    const db = openDb();
    const claimed = await askWhichForge(db, remote);
    if (claimed === null) return fallback;
    const [owner = place.owner, repo = place.repo] = claimed.key.split("/");
    const repository = { name: claimed.key, owner, repo, forge: claimed.forge, remote };
    const body = "Adds the files sc init wrote, so Skelcrew can work on this repository.";
    const number = await openPr(db, repository, {
      branch: setupBranch,
      base,
      title: message,
      body,
    });
    return `Opened pull request #${number}. Merge it, then run sc.`;
  } catch {
    return fallback;
  }
}

export async function offerCommit(root: string, remote: string, files: string[]): Promise<void> {
  const wrote = `Wrote ${listed(files)}.`;
  const base = defaultBranch(root);
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  const ahead = git(root, ["rev-list", "--count", `refs/remotes/origin/${base}..HEAD`]);
  const conflicted = git(root, ["diff", "--name-only", "--diff-filter=U", "--", ...files]).out;
  const why =
    base === null
      ? "Skelcrew couldn't tell the repository's default branch."
      : branch !== base
        ? `This checkout is on ${branch || "no branch"}, not ${base}.`
        : !ahead.ok
          ? `Skelcrew can't compare your ${base} with origin's. Run git fetch first.`
          : ahead.out !== "0"
            ? `Your ${base} has commits origin's doesn't, so Skelcrew won't push it for you.`
            : conflicted
              ? "They hold conflicts."
              : null;
  if (!process.stdin.isTTY || why !== null || base === null) {
    console.log(process.stdin.isTTY && why ? `${wrote} ${why}` : wrote);
    byHand(files, base ?? "main");
    return;
  }
  if (!yes(`${wrote}\nCommit and push them to ${base}?`)) return byHand(files, base);
  const added = git(root, ["add", "--", ...files]);
  const committed = added.ok
    ? git(root, ["commit", "-q", "-m", message, "--only", "--", ...files])
    : added;
  if (!committed.ok) {
    console.log(`Skelcrew couldn't commit them: ${committed.err}`);
    return byHand(files, base);
  }
  const pushed = git(root, ["push", "-q", "origin", `HEAD:refs/heads/${base}`]);
  if (pushed.ok) {
    git(root, ["fetch", "-q", "origin", base]);
    console.log(`Committed them and pushed them to ${base}.`);
    return;
  }
  console.log(`Committed them, but ${base} refused the push:\n${pushed.err}`);
  if (!yes(`Push them to a branch, ${setupBranch}, and open a pull request instead?`)) {
    console.log(
      `To push them to a branch yourself, run:\n${toRun([`git push origin HEAD:${setupBranch}`]).trimEnd()}`,
    );
    return;
  }
  const branched = git(root, ["push", "-q", "origin", `HEAD:refs/heads/${setupBranch}`]);
  if (!branched.ok) {
    console.log(`The push of ${setupBranch} was refused too:\n${branched.err}`);
    return;
  }
  console.log(`Pushed them to ${setupBranch}. ${await openSetupPr(base, remote)}`);
}
