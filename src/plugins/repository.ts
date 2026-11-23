// A repository's plugins: plugins: in its skelcrew.yaml, each pinned at its exact version and
// commit in its skelcrew.lock, which you commit. sc plugin add writes both in your checkout, and
// sc install installs what they pin.
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parse, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { openDb } from "../db.ts";
import { checkoutTop, repositories } from "../flow/repo.ts";
import { errorText } from "../format.ts";
import { originHere } from "../machine/origin.ts";
import { cloneDir, dataDir } from "../paths.ts";
import {
  eachAsked,
  installPlugin,
  lockedAs,
  matchesLock,
  newestLocked,
  refuseOtherName,
  refusePersonal,
  type Shown,
  updatePlugin,
} from "./install.ts";
import { type Lock, type Locked, readLockAt, writeBoth, yourLock, yourPlugins } from "./lock.ts";
import { commitOf, installedPlugins, type Plugin, readManifest } from "./plugin.ts";

// The GitHub plugin, the forge of every repository on github.com.
export const githubPlugin = "skelcrew/skelcrew-github";

// Returns how Skelcrew names the GitHub plugin when it offers it for a repository on GitHub, given
// as owner/name, and what it says first: why it needs the plugin, in plain words. Plain sc and sc
// init offer it the same way.
export const gitHubShown = (repository: string): Shown => ({
  title: "GitHub",
  intro: `This is a GitHub repository (${repository}). Skelcrew needs its GitHub plugin to read issues, open pull requests and merge them.`,
});

// What Skelcrew reads of a repository's skelcrew.yaml here: only plugins:, by the GitHub
// repository each comes from, such as skelcrew/skelcrew-github. The rest is the loader's, in
// settings.ts. A path, such as ./plugin, is refused: a folder plugin has no pin, so a
// repository's files could otherwise pick code of their own to run as you.
const Source = z
  .string()
  .regex(/^\w[\w.-]*\/[\w.-]+$/, "must be owner/repo, such as skelcrew/skelcrew-github");
// A bare plugins: is YAML's null, which names none, as a missing line does.
const Shared = z.looseObject({ plugins: z.array(Source).nullish() });

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
  return { plugins: shared.data.plugins ?? [], lock: readLockAt(lockFile) ?? {} };
}

// Returns the text of a file in a repository, or `start` for one that isn't there yet.
const readOr = (file: string, start: string) =>
  lstatSync(file, { throwIfNoEntry: false }) ? readFileSync(file, "utf8") : start;

// With no line width, a long line, such as a pin on one line, isn't folded, and a list written on
// one line keeps its brackets tight, as people write them.
const asWritten = { lineWidth: 0, flowCollectionPadding: false };

// Returns `text` with `key` set to `value`, changing only where it goes, so every other line stays
// byte for byte, as it would in the human's commit. A key that isn't there is added as a line at
// the end of the document. One with an empty value, such as plugins: [] or a bare plugins:, gets
// the value in its place, on one line.
// Returns null when neither fits, such as for a file written as one map, like {setup: [make]}, or
// a key with a value already, which the whole file must be written again to change.
function editedInPlace(text: string, key: string, value: unknown): string | null {
  const { contents } = parseDocument(text);
  // A line of ... ends the document, so a new line goes before it, or YAML would refuse the file.
  const added = () => {
    const marker = text.search(/^\.\.\.[ \t]*(#.*)?$/m);
    const before = marker === -1 ? text : text.slice(0, marker);
    const after = marker === -1 ? "" : text.slice(marker);
    const line = before === "" || before.endsWith("\n") ? "" : "\n";
    return `${before}${line}${stringify({ [key]: value }, asWritten)}${after}`;
  };
  if (contents === null) return added();
  if (!isMap(contents) || contents.flow) return null;
  const pair = contents.items.find((item) => isScalar(item.key) && item.key.value === key);
  if (!pair) return added();
  const empty = pair.value;
  const blank = isScalar(empty) && empty.value === null;
  const emptyList = isSeq(empty) && empty.items.length === 0;
  if (!(blank || emptyList) || !empty.range) return null;
  const [start, end] = empty.range;
  // A bare key has its empty value right after the colon, or right before a comment on its line,
  // and YAML needs a space on each side of the value.
  const space = text[start - 1] === ":" ? " " : "";
  const spaceAfter = /^[^\s]/.test(text.slice(end)) ? " " : "";
  const flow = stringify(value, { ...asWritten, collectionStyle: "flow" }).trim();
  return `${text.slice(0, start)}${space}${flow}${spaceAfter}${text.slice(end)}`;
}

// Returns `text` with `key` set to `value` as editedInPlace changes it, or null when it can't.
// Only text that reads back as the file did with the value set is kept, so a case editedInPlace
// misses costs the file's spacing, never its meaning.
function withKey(text: string, key: string, value: unknown): string | null {
  const changed = editedInPlace(text, key, value);
  if (changed === null) return null;
  try {
    const Keys = z.record(z.string(), z.unknown());
    const before = Keys.parse(parse(text) ?? {});
    return isDeepStrictEqual(Keys.parse(parse(changed)), { ...before, [key]: value })
      ? changed
      : null;
  } catch {
    return null;
  }
}

// Sets `key` to `value` in the YAML file, keeping its other lines as they are where it can, as
// withKey does, and its comments otherwise. Throws, naming the line to add by hand, for a file
// written as one map, which it never changes. A file that isn't there yet is started with `start`,
// a line on top saying what it is.
function setKey(file: string, start: string, key: string, value: unknown): void {
  const text = readOr(file, start);
  const changed = withKey(text, key, value);
  if (changed !== null) {
    writeFileSync(file, changed);
    return;
  }
  const document = parseDocument(text);
  // Written again, a file written as one map would change on every line, so it is left as it is.
  if (isMap(document.contents) && document.contents.flow) {
    const line = stringify({ [key]: value }, { ...asWritten, collectionStyle: "flow" }).trim();
    throw new Error(
      `${file} is written as one map, which Skelcrew leaves as it is. Add ${line.slice(1, -1)} to it by hand`,
    );
  }
  document.set(key, value);
  writeFileSync(file, document.toString(asWritten));
}

// Names `source` under plugins: in the skelcrew.yaml in `folder`, unless it is there already.
// sc init uses it alone for a plugin the repository's skelcrew.lock pins already, whose pin it
// keeps.
export function namePlugin(folder: string, source: string): void {
  const { plugins } = repositoryPlugins(folder);
  if (plugins.includes(source)) return;
  setKey(
    join(folder, "skelcrew.yaml"),
    "# Shared with everyone who works on this repository. Never put a secret here.\n",
    "plugins",
    [...plugins, source],
  );
}

// The first line of a repository's skelcrew.lock, which is all one that pins nothing holds.
export const lockStart = "# Written by sc plugin add and sc plugin update. Commit it.\n";

function nameAndPin(folder: string, source: string, locked: Locked): void {
  namePlugin(folder, source);
  setKey(join(folder, "skelcrew.lock"), lockStart, source, locked);
}

// Returns the installed plugins without changing Skelcrew's state: none on a machine where Skelcrew
// never ran, and none when its state can't be read as it is, such as before an older Skelcrew
// made its plugins table.
function installedReadOnly(): Plugin[] {
  const file = join(dataDir(), "skelcrew.db");
  if (!existsSync(file)) return [];
  try {
    const db = new Database(file, { readonly: true });
    try {
      return installedPlugins(db);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

// Names `source` in the skelcrew.yaml in `folder` and pins it in its skelcrew.lock, for sc init,
// installing nothing: at the version installed here from the same source, or else at its newest.
// Skelcrew's state is only read, so sc init leaves nothing on the machine.
export function pinRepositoryPlugin(folder: string, source: string): void {
  const here = installedReadOnly().find((plugin) => plugin.source === source);
  const locked = here
    ? lockedAs(readManifest(here.folder), commitOf(here.folder))
    : newestLocked(source);
  writeBoth(
    () => nameAndPin(folder, source, locked),
    [join(folder, "skelcrew.yaml"), join(folder, "skelcrew.lock")],
  );
}

export function addRepositoryPlugin(given: string, shown: Shown = {}): string | null {
  if (given.startsWith(".") || given.startsWith("/"))
    throw new Error(
      `a plugin from a folder is on this machine only, so a repository can't name it. sc plugin add -g ${given} adds it as yours`,
    );
  const top = checkoutTop();
  if (top === null)
    throw new Error(
      "sc plugin add without -g adds a plugin to the repository you are in, and this folder isn't in a checkout of one. sc plugin add -g adds it as yours",
    );
  repositoryPlugins(top);
  const db = openDb();
  const installed = () => installedPlugins(db).find((plugin) => plugin.source === given);
  const fresh = !installed();
  if (fresh && !installPlugin(given, { remote: originHere(top), pin: false, io: true, shown }))
    return null;
  const plugin = installed();
  if (!plugin) throw new Error(`${given} isn't installed after all`);
  const manifest = readManifest(plugin.folder);
  refusePersonal(manifest, true);
  writeBoth(
    () => nameAndPin(top, given, lockedAs(manifest, commitOf(plugin.folder))),
    [join(top, "skelcrew.yaml"), join(top, "skelcrew.lock")],
  );
  const pinned = fresh ? "" : ", at the version installed here";
  return `Added ${manifest.name} ${manifest.version} to skelcrew.yaml and skelcrew.lock${pinned}. They count once you commit and push them.`;
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

// Returns why what the repositories Skelcrew has need can't be told, or null when it can.
// `unreadable` are those whose files can't be read, as repositoryNeeds gives them. A repository
// whose clone isn't there, such as one not cloned yet or removed for holding a token, counts too:
// its files would read as naming no plugin. While either holds, sc install removes no plugin.
export function cantTell(unreadable: string[]): string | null {
  if (unreadable.length > 0) return `Skelcrew can't read the plugins of ${unreadable.join("; ")}`;
  const missing = repositories(openDb()).filter((r) => !existsSync(cloneDir(r.owner, r.repo)));
  if (missing.length > 0)
    return `Skelcrew's clone of ${missing.map((r) => r.name).join(", ")} isn't there yet`;
  return null;
}

// Returns where repositories' files are read: the checkout you are in, as you see it there, and
// with `everywhere`, or outside a checkout, Skelcrew's clone of each repository it has, at its
// default branch. Each comes with the name said for it and its remote.
function places(everywhere: boolean): { folder: string; where: string; remote: string | null }[] {
  const top = checkoutTop();
  const clones = repositories(openDb()).map((r) => ({
    folder: cloneDir(r.owner, r.repo),
    where: r.name,
    remote: r.remote,
  }));
  return [
    ...(top !== null ? [{ folder: top, where: "This checkout", remote: originHere(top) }] : []),
    ...(top === null || everywhere ? clones : []),
  ];
}

// Returns every plugin the checkout you are in or any repository Skelcrew has names in its
// skelcrew.yaml or pins in its skelcrew.lock, for sc install and sc plugin ls, which never remove
// one. A pin with no line in skelcrew.yaml counts too: it is stale, but removing the plugin would
// lose its settings and tokens. What can't be read goes into `unreadable`, as for repositoryNeeds.
export function everyNamed(unreadable: string[]): string[] {
  return places(true).flatMap(({ folder, where }) => {
    try {
      const { plugins, lock } = repositoryPlugins(folder);
      return [...plugins, ...Object.keys(lock)];
    } catch (error) {
      unreadable.push(`${where}: ${errorText(error)}`);
      return [];
    }
  });
}

// Returns the plugins repositories need, for sc install and sc plugin ls: in a checkout, those its
// files name, as you see them there. Outside one, those of every repository Skelcrew has, from
// Skelcrew's clone of its default branch. `everywhere` adds every repository Skelcrew has to the
// checkout's, for sc plugin rm -g, which must keep a plugin any of them needs. Each one's pin is
// compared with your lock's and the other repositories', so a disagreement is said rather than
// settled by whichever is read last. A repository whose files can't be read throws, unless
// `unreadable` is given: then what is wrong goes there, and the other repositories still count,
// so one broken file can't hide another repository's pins.
export function repositoryNeeds(
  everywhere = false,
  unreadable?: string[],
  root?: string | null,
): Need[] {
  const selected =
    root === undefined
      ? places(everywhere)
      : root === null
        ? []
        : [{ folder: root, where: "This checkout", remote: originHere(root) }];
  const needs = selected.flatMap(({ folder, where, remote }) => {
    try {
      const { plugins, lock } = repositoryPlugins(folder);
      return plugins.map((source) => ({ source, where, locked: lock[source], remote }));
    } catch (error) {
      if (unreadable === undefined) throw error;
      unreadable.push(`${where}: ${errorText(error)}`);
      return [];
    }
  });
  // Every pin of each source, yours first, each with who pins it.
  const yours = yourLock();
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

export function installRepositoryPlugins(needs: Need[]): { changed: boolean; missing: boolean } {
  if (needs.length === 0) return { changed: false, missing: false };
  const db = openDb();
  let changed = false;
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
          `${where}'s skelcrew.yaml names ${source}, which its skelcrew.lock doesn't pin, so Skelcrew didn't install it. sc plugin add ${source} pins it.`,
        );
        return;
      }
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      if (here && matchesLock(here, locked)) {
        refusePersonal(readManifest(here.folder), true);
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

// Reports whether the repository Skelcrew keeps in `folder` needs you to run sc install: its files
// name a plugin this machine lacks at the version and commit its skelcrew.lock pins, one with no
// pin, one sc install refuses, such as a runtime plugin, or can't be read, which sc install then
// says. The daemon can't install anything itself, as
// only a yes at your terminal can, so the repository's row in sc repo ls says to.
export function needsInstall(folder: string): boolean {
  try {
    const db = openDb();
    const { plugins, lock } = repositoryPlugins(folder);
    return plugins.some((source) => {
      if (db.query("SELECT 1 FROM removed_plugins WHERE source = ?").get(source)) return false;
      const locked = lock[source];
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      if (!locked || !here || !matchesLock(here, locked)) return true;
      // Installed as yours at the pin, it still doesn't count when sc install would refuse it.
      const manifest = readManifest(here.folder);
      return manifest.kind === "runtime" || manifest.name !== locked.name;
    });
  } catch {
    return true;
  }
}
