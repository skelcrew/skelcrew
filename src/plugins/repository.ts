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
import { eachAsked, installPlugin, lockedAs, matchesLock, updatePlugin } from "./install.ts";
import { type Lock, type Locked, readLock, settleYourLock, writeBoth } from "./lock.ts";
import { commitOf, installedPlugins, readManifest } from "./plugin.ts";

// What Skelcrew reads of a repository's skelcrew.yaml here: only plugins:, by the GitHub
// repository each comes from. The rest is the loader's, in settings.ts.
const Shared = z.looseObject({ plugins: z.array(z.string().min(1)).optional() });

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
  if (!installed() && !installPlugin(given, { remote: originHere(top), pin: false })) return false;
  const plugin = installed();
  if (!plugin) throw new Error(`${given} isn't installed after all`);
  const manifest = readManifest(plugin.folder);
  writeBoth(
    () => nameAndPin(top, given, lockedAs(manifest, commitOf(plugin.folder))),
    [join(top, "skelcrew.yaml"), join(top, "skelcrew.lock")],
  );
  console.log(
    `Added ${manifest.name} ${manifest.version} to skelcrew.yaml and skelcrew.lock. They count once you commit and push them.`,
  );
  return true;
}

// Installs the plugins a repository's files name, at the version and commit its skelcrew.lock
// pins, for sc install. `where` names the repository in what is said, such as "This checkout".
// A plugin new here, or at another version or commit, is shown and asked about. One already at
// its pin asks nothing. One with no pin isn't installed, as only sc add writes into a repository.
// Your lock is left alone, as these plugins aren't yours. Returns whether there was anything to
// do, and the plugins still missing or at another version than pinned.
function installFrom(
  folder: string,
  where: string,
  remote: string | null,
): { changed: boolean; left: string[] } {
  const db = openDb();
  const { plugins, lock } = repositoryPlugins(folder);
  if (plugins.length === 0) return { changed: false, left: [] };
  settleYourLock(db);
  let changed = false;
  eachAsked(
    plugins,
    (source) => source,
    (source) => {
      const locked = lock[source];
      if (!locked) {
        console.log(
          `${where}'s skelcrew.yaml names ${source}, which its skelcrew.lock doesn't pin, so Skelcrew didn't install it. sc add ${source} pins it.`,
        );
        return;
      }
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      if (here && matchesLock(here, locked)) return;
      changed = true;
      const pinned = { tag: `v${locked.version}`, commit: locked.commit, remote, pin: false };
      if (here) updatePlugin(db, here, pinned);
      else installPlugin(source, pinned);
    },
  );
  // Read again, as each install changed what is here.
  const left = plugins.filter((source) => {
    const here = installedPlugins(db).find((plugin) => plugin.source === source);
    const locked = lock[source];
    return locked !== undefined && (!here || !matchesLock(here, locked));
  });
  for (const source of left)
    console.log(
      `${where} needs ${source} at the version its skelcrew.lock pins. sc install asks again.`,
    );
  const unpinned = plugins.filter((source) => lock[source] === undefined);
  return { changed, left: [...left, ...unpinned] };
}

// Installs the plugins repositories name, for sc install: in a checkout, those its files name,
// as you see them there. Outside one, those of every repository Skelcrew has, from Skelcrew's
// clone of its default branch. Returns whether there was anything to do, and whether any plugin
// is still missing. A missing one never takes the machine's set-up mark, as it is the
// repository's, not yours.
export function installRepositoryPlugins(): { changed: boolean; missing: boolean } {
  const top = checkoutTop();
  const places =
    top !== null
      ? [{ folder: top, where: "This checkout", remote: originHere(top) }]
      : repositories(openDb()).map((r) => ({
          folder: cloneDir(r.owner, r.repo),
          where: r.name,
          remote: r.remote,
        }));
  let changed = false;
  let missing = false;
  for (const { folder, where, remote } of places) {
    const done = installFrom(folder, where, remote);
    changed ||= done.changed;
    missing ||= done.left.length > 0;
  }
  return { changed, missing };
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
