// A repository's plugins: plugins: in its skelcrew.yaml, each pinned at its exact version and
// commit in its skelcrew.lock, which you commit. sc add writes both in your checkout, and sc
// install installs what they pin.
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { openDb } from "../db.ts";
import { checkoutTop, repositories } from "../flow/repo.ts";
import { originHere } from "../machine/origin.ts";
import { cloneDir } from "../paths.ts";
import {
  eachAsked,
  installPlugin,
  lockedAs,
  matchesLock,
  refuseOtherName,
  refuseRuntime,
  removePlugin,
  updatePlugin,
} from "./install.ts";
import {
  type Lock,
  type Locked,
  readLock,
  settleYourLock,
  writeBoth,
  yourLock,
  yourPlugins,
} from "./lock.ts";
import { commitOf, installedPlugins, readManifest } from "./plugin.ts";

// What Skelcrew reads of a repository's skelcrew.yaml here: only plugins:, by the GitHub
// repository each comes from, such as skelcrew/skelcrew-github. The rest is the loader's, in
// settings.ts. A path, such as ./plugin, is refused: a folder plugin has no pin, so a
// repository's files could otherwise pick code of their own to run as you.
const Source = z
  .string()
  .regex(/^\w[\w.-]*\/[\w.-]+$/, "must be owner/repo, such as skelcrew/skelcrew-github");
const Shared = z.looseObject({ plugins: z.array(Source).optional() });

// Throws when `file` is there but isn't a plain file. A repository's files are someone else's
// writing, and a link in them could point Skelcrew at any file of yours.
function refuseLink(file: string): void {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new Error(`${file} isn't a plain file, so Skelcrew won't read it`);
}

// Returns the plugins the skelcrew.yaml in `folder` names and the pins of its skelcrew.lock,
// both checked. `folder` is your checkout or Skelcrew's clone. A file that isn't there names and
// pins nothing.
export function repositoryPlugins(folder: string): { plugins: string[]; lock: Lock } {
  const yamlFile = join(folder, "skelcrew.yaml");
  const lockFile = join(folder, "skelcrew.lock");
  refuseLink(yamlFile);
  refuseLink(lockFile);
  let data: unknown = null;
  if (lstatSync(yamlFile, { throwIfNoEntry: false })) {
    try {
      data = parse(readFileSync(yamlFile, "utf8"));
    } catch (error) {
      throw new Error(`${yamlFile} isn't valid YAML: ${String(error)}`);
    }
  }
  // An empty file is YAML's null.
  const shared = Shared.safeParse(data ?? {});
  if (!shared.success) throw new Error(`${yamlFile} isn't valid: ${z.prettifyError(shared.error)}`);
  return { plugins: shared.data.plugins ?? [], lock: readLock(lockFile) };
}

// Names `source` under plugins: in the skelcrew.yaml in `folder`, and pins it in its
// skelcrew.lock. Both files are changed in place, so their comments and other lines stay. A file
// that isn't there yet is started with a line on top saying what it is.
function nameAndPin(folder: string, source: string, locked: Locked): void {
  const yamlFile = join(folder, "skelcrew.yaml");
  const lockFile = join(folder, "skelcrew.lock");
  const { plugins } = repositoryPlugins(folder);
  const read = (file: string, start: string) =>
    lstatSync(file, { throwIfNoEntry: false }) ? readFileSync(file, "utf8") : start;
  const shared = parseDocument(
    read(
      yamlFile,
      "# Shared with everyone who works on this repository. Never put a secret here.\n",
    ),
  );
  if (!plugins.includes(source)) shared.set("plugins", [...plugins, source]);
  const lock = parseDocument(read(lockFile, "# Written by sc add and sc update. Commit it.\n"));
  lock.set(source, locked);
  // With no line width, a long line, such as a pin on one line, isn't folded, and a list
  // written on one line keeps its brackets tight, as people write them.
  writeFileSync(yamlFile, shared.toString({ lineWidth: 0, flowCollectionPadding: false }));
  writeFileSync(lockFile, lock.toString({ lineWidth: 0, flowCollectionPadding: false }));
}

// Adds a plugin to the repository you are in, for sc add without -g: installs it after asking,
// then names it in the checkout's skelcrew.yaml and pins its version and commit in its
// skelcrew.lock. A plugin installed here already is pinned at its version with nothing to ask,
// as you approved that exact version before. Returns whether it was added.
export function addRepositoryPlugin(given: string): boolean {
  // A folder's path means nothing on a teammate's machine, and it has no version to pin.
  if (given.startsWith(".") || given.startsWith("/"))
    throw new Error(
      `a plugin from a folder is on this machine only, so a repository can't name it. sc add -g ${given} adds it as yours`,
    );
  const top = checkoutTop();
  if (top === null)
    throw new Error(
      "sc add without -g adds a plugin to the repository you are in, and this folder isn't in a checkout of one. sc add -g adds it as yours",
    );
  // Read first, so files that aren't valid stop the add before anything installs.
  repositoryPlugins(top);
  const db = openDb();
  // Your lock must be in place before a plugin that isn't yours is installed.
  settleYourLock(db);
  const installed = () => installedPlugins(db).find((plugin) => plugin.source === given);
  // The repository's plugin goes into its own files, never into your lock.
  const fresh = !installed();
  if (fresh && !installPlugin(given, { remote: originHere(top), pin: false, io: true }))
    return false;
  const plugin = installed();
  if (!plugin) throw new Error(`${given} isn't installed after all`);
  const manifest = readManifest(plugin.folder);
  refuseRuntime(manifest, true);
  try {
    writeBoth(
      () => nameAndPin(top, given, lockedAs(manifest, commitOf(plugin.folder))),
      [join(top, "skelcrew.yaml"), join(top, "skelcrew.lock")],
    );
  } catch (error) {
    // The files and the machine change together: a plugin this add installed goes again, with
    // its settings and tokens. Its removal failing says nothing of why the add failed, so the
    // add's own error is the one shown.
    if (fresh)
      try {
        removePlugin(manifest.name);
      } catch {}
    throw error;
  }
  console.log(
    `Added ${manifest.name} ${manifest.version} to skelcrew.yaml and skelcrew.lock. They count once you commit and push them.`,
  );
  return true;
}

// One plugin a repository needs: its source, the repository that names it, as `where` says it,
// such as "This checkout", the pin of that repository's skelcrew.lock, if any, and the remote
// handed to the plugin's setup. `conflict` says which other pins disagree with this one, or is
// null when none does. A machine holds one version of a plugin, so a plugin pinned at two commits
// can't match both, and sc install leaves it until the pins agree.
export type Need = {
  source: string;
  where: string;
  locked: Locked | undefined;
  remote: string | null;
  conflict: string | null;
};

// Returns how a pin reads in what is said, such as 0.1.0 at commit 4f9c2e1a7b0c.
const pinText = (locked: Locked) => `${locked.version} at commit ${locked.commit.slice(0, 12)}`;

// Returns the plugins repositories need, for sc install and sc plugins: in a checkout, those its
// files name, as you see them there. Outside one, those of every repository Skelcrew has, from
// Skelcrew's clone of its default branch. Each one's pin is compared with your lock's and the
// other repositories', so a disagreement is said rather than settled by whichever is read last.
export function repositoryNeeds(): Need[] {
  const db = openDb();
  const top = checkoutTop();
  const places =
    top !== null
      ? [{ folder: top, where: "This checkout", remote: originHere(top) }]
      : repositories(db).map((r) => ({
          folder: cloneDir(r.owner, r.repo),
          where: r.name,
          remote: r.remote,
        }));
  const needs = places.flatMap(({ folder, where, remote }) => {
    const { plugins, lock } = repositoryPlugins(folder);
    return plugins.map((source) => ({ source, where, locked: lock[source], remote }));
  });
  // Every pin of each source, yours first, each with who pins it.
  const yours = yourLock(db);
  const pins = (source: string) => {
    const mine = yourPlugins().includes(source) ? yours[source] : undefined;
    return [
      ...(mine ? [{ by: "your lock", locked: mine }] : []),
      ...needs.flatMap(({ source: other, where, locked }) =>
        other === source && locked ? [{ by: where, locked }] : [],
      ),
    ];
  };
  return needs.map((need) => {
    const all = pins(need.source);
    const agree = all.every(({ locked }) => locked.commit === all[0]?.locked.commit);
    const conflict = agree
      ? null
      : all.map(({ by, locked }) => `${pinText(locked)} by ${by}`).join(", ");
    return { ...need, conflict };
  });
}

// Installs the plugins repositories need, as repositoryNeeds gave them, for sc install, at the
// version and commit each one's skelcrew.lock pins. A plugin new here, or at another version or commit, is shown and asked
// about. One already at its pin asks nothing. One with no pin isn't installed, as only sc add
// writes into a repository, and nor is one pinned at two commits, which no machine can match.
// Nor is one whose manifest names another plugin than the lock does. Your lock is left alone, as
// these plugins aren't yours. Returns whether there was anything to do, and whether any plugin is
// still missing. A missing one never takes the machine's set-up
// mark, as it is the repository's, not yours.
export function installRepositoryPlugins(needs: Need[]): { changed: boolean; missing: boolean } {
  if (needs.length === 0) return { changed: false, missing: false };
  const db = openDb();
  settleYourLock(db);
  let changed = false;
  // Each disagreement is said once, however many repositories share it.
  const said = new Set<string>();
  eachAsked(
    needs,
    ({ source }) => source,
    ({ source, where, locked, remote, conflict }) => {
      if (conflict !== null) {
        if (!said.has(source))
          console.log(
            `${source} is pinned at ${conflict}. A machine holds one version of a plugin, so Skelcrew left it as it is. Pin the same version in each.`,
          );
        said.add(source);
        return;
      }
      if (!locked) {
        console.log(
          `${where}'s skelcrew.yaml names ${source}, which its skelcrew.lock doesn't pin, so Skelcrew didn't install it. sc add ${source} pins it.`,
        );
        return;
      }
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      // One installed as yours at this very pin may be a runtime plugin, which a repository
      // can't name, or another plugin than the lock names. One at another pin is checked as the
      // pinned version is fetched, as that version may differ.
      if (here && matchesLock(here, locked)) {
        refuseRuntime(readManifest(here.folder), true);
        refuseOtherName(readManifest(here.folder), locked.name);
        return;
      }
      changed = true;
      const pinned = {
        called: locked.name,
        tag: `v${locked.version}`,
        commit: locked.commit,
        remote,
        pin: false,
        io: true,
      };
      if (here) updatePlugin(db, here, pinned);
      else installPlugin(source, pinned);
    },
  );
  // Read again, as each install changed what is here.
  const left = needs.filter(({ source, locked, conflict }) => {
    const here = installedPlugins(db).find((plugin) => plugin.source === source);
    return conflict === null && locked && (!here || !matchesLock(here, locked));
  });
  for (const { source, where } of left)
    console.log(
      `${where} needs ${source} at the version its skelcrew.lock pins. sc install asks again.`,
    );
  const missing = needs.some(({ locked, conflict }) => !locked || conflict !== null);
  return { changed, missing: missing || left.length > 0 };
}

// Reports whether the skelcrew.yaml of the checkout you are in names `source`, so plain sc
// leaves that plugin to sc install, at the version the repository pins. Files that can't be read
// name nothing here, as sc install says what is wrong with them.
export function checkoutNames(source: string): boolean {
  const top = checkoutTop();
  if (top === null) return false;
  try {
    return repositoryPlugins(top).plugins.includes(source);
  } catch {
    return false;
  }
}
