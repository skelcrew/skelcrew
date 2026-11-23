// sc install installs the plugins named by a checkout and by the personal lock.
// It never chooses harnesses, signs agents in, or sets up the daemon.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutTop } from "../flow/repo.ts";
import { originHere, parseRemote } from "../machine/origin.ts";
import { installYourPlugins } from "./install.ts";
import { installRepositoryPlugins, repositoryNeeds } from "./repository.ts";

export function installFiles(from?: string): boolean {
  const temporary = from ? mkdtempSync(join(tmpdir(), "skelcrew-install-")) : null;
  try {
    let root = checkoutTop();
    if (from && temporary) {
      if (!parseRemote(from)) throw new Error(`${from} isn't a repository remote`);
      root = join(temporary, "repository");
      const cloned = Bun.spawnSync(["git", "clone", "--depth=1", "--", from, root], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!cloned.success)
        throw new Error(`couldn't read ${from}: ${cloned.stderr.toString().trim()}`);
    }
    const unreadable: string[] = [];
    const needs = repositoryNeeds(false, unreadable, root);
    const conflicts = needs.filter((need) => need.conflict !== null).map((need) => need.source);
    const personal = installYourPlugins(from ?? originHere(), conflicts);
    const repository = installRepositoryPlugins(needs);
    for (const problem of unreadable)
      console.log(`Skelcrew couldn't read ${problem}. Fix it, then run sc install again.`);
    if (
      !personal.changed &&
      !repository.changed &&
      !repository.missing &&
      personal.left.length === 0 &&
      unreadable.length === 0
    )
      console.log("Nothing to install: this machine has everything your files ask for.");
    return personal.left.length === 0 && !repository.missing && unreadable.length === 0;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
