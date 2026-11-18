// Your personal plugins: sc install, sc add -g, sc remove -g, sc update -g, sc setup and sc
// plugins. A plugin comes from a version tag on GitHub, pinned in your own lock, or from a folder
// of yours. Only you run these, in your own terminal.
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDb } from "../db.ts";
import { repositories } from "../flow/repo.ts";
import { originHere } from "../machine/origin.ts";
import { configDir, dataDir } from "../paths.ts";
import { removeControlCodes } from "../screen/look.ts";
import { release } from "../version.ts";
import { trackerOf } from "./ask.ts";
import { commitOf, type Locked, setLocked, setYourPlugins, yourLock, yourPlugins } from "./lock.ts";
import {
  commandFor,
  findPlugin,
  installedPlugins,
  type Manifest,
  type Plugin,
  readManifest,
  Version,
} from "./plugin.ts";

// Where plugins installed from GitHub live, each version in a folder of its own.
const pluginsDir = () => join(dataDir(), "plugins");

// Returns whether version a comes after version b, both such as 0.10.0.
function newer(a: string, b: string): boolean {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  // The first part that differs decides.
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// Returns the newest version tag of a GitHub repository, such as v0.2.0, asking GitHub only
// for its tags. Tags that aren't versions are passed over.
function newestTag(source: string): string {
  // With no terminal prompt, a repository that doesn't exist fails at once, where git would
  // otherwise ask for a login.
  const listed = Bun.spawnSync(
    ["git", "ls-remote", "--tags", "--refs", `https://github.com/${source}`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (!listed.success)
    throw new Error(`git couldn't reach ${source} on GitHub: ${listed.stderr.toString().trim()}`);
  // Each line ends with the tag's ref, such as refs/tags/v0.2.0.
  const versions = listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.split("refs/tags/v")[1] ?? "")
    .filter((version) => Version.safeParse(version).success);
  const newest = versions.reduce((a, b) => (newer(b, a) ? b : a), "");
  if (!newest) throw new Error(`${source} has no version tag, such as v0.1.0, to install from`);
  return `v${newest}`;
}

// Fetches a GitHub repository into a temporary folder beside the installed plugins: at `commit`
// when your lock pins one, or else at the version tag. Returns that folder, its manifest and its
// commit, once the manifest's version matches the tag. The caller moves the folder into place
// only after you agree, so a fetch stopped halfway never looks like a plugin.
function cloneTag(
  source: string,
  tag: string,
  commit?: string,
): { staged: string; manifest: Manifest; commit: string } {
  // Staged beside the plugins, so a rename moves it into place. A name starting with a dot
  // can't be a plugin's.
  const staged = join(pluginsDir(), `.cloning-${process.pid}`);
  mkdirSync(pluginsDir(), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  const url = `https://github.com/${source}`;
  // With no terminal prompt, a repository that doesn't exist fails at once, where git would
  // otherwise ask for a login.
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-c", "advice.detachedHead=false", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  if (commit === undefined) {
    const cloned = git(["clone", "--quiet", "--depth", "1", "--branch", tag, url, staged]);
    if (!cloned.success)
      throw new Error(`git couldn't clone ${source} at ${tag}: ${cloned.stderr.toString().trim()}`);
  } else {
    // The pinned commit is fetched by itself, so a tag moved since it was locked still installs
    // exactly the code you approved. git can't clone a commit, only a branch or a tag, so the
    // folder starts empty and fetches it.
    const steps = [
      ["init", "--quiet", staged],
      ["-C", staged, "fetch", "--quiet", "--depth", "1", url, commit],
      ["-C", staged, "checkout", "--quiet", "FETCH_HEAD"],
    ];
    for (const step of steps) {
      const run = git(step);
      if (run.success) continue;
      rmSync(staged, { recursive: true, force: true });
      throw new Error(
        `git couldn't fetch commit ${commit.slice(0, 12)} of ${source}, which your lock pins: ${run.stderr.toString().trim()}. sc update -g moves it to its newest version, after showing what it runs`,
      );
    }
  }
  // A tag or commit that disagrees with its manifest is refused, so the version you were told
  // is the one that runs.
  try {
    const manifest = readManifest(staged);
    if (`v${manifest.version}` !== tag)
      throw new Error(
        `${source} isn't installable: its tag ${tag} says ${tag.slice(1)}, and its skelcrew-plugin.yaml ${manifest.version}`,
      );
    return { staged, manifest, commit: commitOf(staged) };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

// Throws when the plugin needs a newer Skelcrew than this one. A build from a checkout has no
// release to compare, and takes any plugin.
function checkSkelcrewVersion(manifest: Manifest): void {
  if (release && newer(manifest.skelcrew, release))
    throw new Error(
      `${manifest.name} ${manifest.version} needs Skelcrew ${manifest.skelcrew} or newer, and this is Skelcrew ${release}`,
    );
}

// Asks a question at your terminal that Enter, y or yes answers yes. Returns true for yes, false
// for any other answer, and null when there is no answer: with no terminal, or after Ctrl-D.
// Only a terminal counts, so an answer piped in from a script or the engine never installs a
// plugin. Bun's own prompt gives null both for a bare Enter and for the end of the input, which
// would take silence for a yes. The answer is read a byte at a time, so a question after this one
// still finds its own line.
export function askYes(question: string): boolean | null {
  if (!process.stdin.isTTY) {
    console.log(`${question} There is no terminal to answer in, so Skelcrew takes that as no.`);
    return null;
  }
  writeSync(1, `${question} `);
  const byte = Buffer.alloc(1);
  let line = "";
  while (true) {
    // A read that fails, such as on a closed input, counts as its end.
    let read = 0;
    try {
      read = readSync(0, byte);
    } catch {}
    if (read === 0 && line === "") return null;
    if (read === 0 || byte[0] === 10) break;
    line += byte.toString();
  }
  return ["", "y", "yes"].includes(line.trim().toLowerCase());
}

// Shows what the plugin is and runs, and asks whether to `verb` it, such as Install. It says the
// plugin's name, source, version, kind, what it provides and every command its manifest runs, as
// it runs as you, outside the sandbox. Returns whether you went ahead. Anything but a yes stops
// it, a typo or no answer included, and nothing of the plugin runs before this.
function confirmPlugin(manifest: Manifest, from: string, verb: string): boolean {
  const { name, version, kind, provides } = manifest;
  const kindName = kind === "io" ? "an I/O" : "a runtime";
  const { build = [], setup, call, git_credentials, add, exec, push } = manifest;
  const commands = [...build, setup, call, git_credentials, add, exec, push]
    .filter((words) => words !== undefined)
    .map((words) => `  ${removeControlCodes(words.join(" "))}`);
  console.log(
    `${name} ${version} from ${removeControlCodes(from)} is ${kindName} plugin that provides ${provides.join(", ")}. It runs these as you, outside Skelcrew's sandbox:\n${commands.join("\n")}`,
  );
  return askYes(`${verb} it? [Y/n]`) === true;
}

// Runs one of a plugin's commands in your terminal, in the plugin's folder, so a setup can ask
// you things. `remote` is the remote of the checkout sc ran in, handed over as SKELCREW_REMOTE so
// a setup can set itself up for that repository, such as install an app on it. Throws when it
// fails.
function runInTerminal(
  manifest: Manifest,
  folder: string,
  words: string[],
  remote: string | null,
): void {
  const { argv, env } = commandFor(manifest.name, words);
  const run = Bun.spawnSync(argv, {
    cwd: folder,
    env: { ...process.env, ...env, ...(remote ? { SKELCREW_REMOTE: remote } : {}) },
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!run.success)
    throw new Error(`${manifest.name}'s ${removeControlCodes(words.join(" "))} failed`);
}

// Runs a plugin's build commands in its folder, then its setup when `setup` is true. Each gets
// `remote`, the remote of the checkout sc ran in. Throws when one fails.
function buildAndSetUp(
  manifest: Manifest,
  folder: string,
  setup: boolean,
  remote: string | null,
): void {
  const commands = [
    ...(manifest.build ?? []),
    ...(setup && manifest.setup ? [manifest.setup] : []),
  ];
  for (const words of commands) runInTerminal(manifest, folder, words, remote);
}

// Runs an installed plugin's setup again in your terminal, such as to sign in again once its
// sign-in has lapsed, handing it `remote`, the repository to set itself up for. Reinstalling
// would do it too, but would fetch and build the plugin again for nothing. sc setup
// runs it for the checkout you are in, and plain sc for a repository whose forge needs it.
export function setUpPlugin(name: string, remote: string | null): void {
  const { folder } = findPlugin(openDb(), name);
  const manifest = readManifest(folder);
  if (!manifest.setup) throw new Error(`${name} has no setup to run`);
  runInTerminal(manifest, folder, manifest.setup, remote);
}

// When the plugin is a forge, marks each repository with no forge as not yet claimed. Skelcrew
// then asks the forges again, so a repository added before this forge can gain it.
function markUnclaimed(db: Database, manifest: Manifest): void {
  if (manifest.provides.includes("forge"))
    db.run("UPDATE repositories SET claimed = 0 WHERE forge IS NULL");
}

// Throws when a plugin of that name is installed already, as one name can't be two plugins.
function refuseInstalled(db: Database, name: string): void {
  if (installedPlugins(db).some((plugin) => plugin.name === name))
    throw new Error(`${name} is installed already: run sc update -g ${name}`);
}

// What installing or updating a plugin may be told. `remote` is the remote of the checkout sc ran
// in, handed to the plugin's setup. `ask` is false when you said yes already, on the laptop whose
// setup a server takes. `tag` picks the
// version, such as v0.1.0, in place of the newest, and `commit` is the one your lock pins it at.
type Options = { remote?: string | null; ask?: boolean; tag?: string; commit?: string };

// Installs a plugin and returns whether it did. `given` is either owner/repo, installed from that
// GitHub repository's newest version tag or the one `tag` names, or a path to a folder of yours,
// used where it is. It shows what the plugin runs and asks first. Then it runs the plugin's build
// and setup, and pins one from GitHub in your lock.
export function installPlugin(given: string, options: Options = {}): boolean {
  const { ask = true, tag, commit } = options;
  const remote = options.remote === undefined ? originHere() : options.remote;
  const db = openDb();
  const isPath = given.startsWith(".") || given.startsWith("/");
  // A folder of yours is used where it is, found by its real path so a link that moves later
  // doesn't move the plugin.
  if (isPath) {
    const folder = realpathSync(resolve(given));
    const manifest = readManifest(folder);
    refuseInstalled(db, manifest.name);
    checkSkelcrewVersion(manifest);
    if (!confirmPlugin(manifest, folder, "Install")) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return false;
    }
    buildAndSetUp(manifest, folder, true, remote);
    db.run("INSERT INTO plugins (name, folder, source) VALUES (?, ?, NULL)", [
      manifest.name,
      folder,
    ]);
    markUnclaimed(db, manifest);
    console.log(`Installed ${manifest.name} ${manifest.version}.`);
    return true;
  }
  // A name starting with a dash would reach git as an option.
  if (!/^[\w.][\w.-]*\/[\w.-]+$/.test(given))
    throw new Error(`${given} is neither a folder, such as ./skelcrew-linear, nor owner/repo`);
  // Nothing of the clone runs before the checks and your yes.
  const cloned = cloneTag(given, tag ?? newestTag(given), commit);
  const { staged, manifest } = cloned;
  try {
    refuseInstalled(db, manifest.name);
    checkSkelcrewVersion(manifest);
    if (!ask) console.log(`Installing ${manifest.name} ${manifest.version} from ${given}...`);
    else if (!confirmPlugin(manifest, given, "Install")) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return false;
    }
    // Anything left of an earlier install of the name goes, as the plugin isn't installed.
    const folder = join(pluginsDir(), manifest.name, manifest.version);
    rmSync(dirname(folder), { recursive: true, force: true });
    mkdirSync(dirname(folder), { recursive: true });
    renameSync(staged, folder);
    // A build or setup that fails takes the plugin's folder with it, so nothing half
    // installed stays.
    try {
      buildAndSetUp(manifest, folder, true, remote);
    } catch (error) {
      rmSync(dirname(folder), { recursive: true, force: true });
      throw error;
    }
    db.run("INSERT INTO plugins (name, folder, source) VALUES (?, ?, ?)", [
      manifest.name,
      folder,
      given,
    ]);
    setLocked(db, given, lockedAs(manifest, cloned.commit));
    markUnclaimed(db, manifest);
    console.log(`Installed ${manifest.name} ${manifest.version}.`);
    return true;
  } finally {
    // Only a clone that never moved into place is still there.
    rmSync(staged, { recursive: true, force: true });
  }
}

// Returns how the lock pins a plugin at this manifest's version and this commit.
const lockedAs = (manifest: Manifest, commit: string): Locked => ({
  name: manifest.name,
  version: manifest.version,
  commit,
});

// Updates one plugin. One from a folder is built again from it, so your edits count. One from
// GitHub moves to its newest version tag, or to the one `tag` names at the lock's `commit`, after
// showing what it runs and asking, as installing does. Its old version's folder goes, and your
// lock pins the new one.
export function updatePlugin(db: Database, plugin: Plugin, options: Options = {}): void {
  const { ask = true, tag: wanted, commit } = options;
  const remote = options.remote === undefined ? originHere() : options.remote;
  const { name, folder, source } = plugin;
  const current = readManifest(folder);
  // A folder of yours gets only its build again, after showing what it runs now and asking, as
  // its commands may have changed since it was installed. Its setup is for sc setup.
  if (source === null) {
    if (ask && !confirmPlugin(current, folder, "Build")) {
      console.log(`Skelcrew didn't build ${name} again.`);
      return;
    }
    buildAndSetUp(current, folder, false, originHere());
    console.log(`Built ${name} ${current.version} again from ${folder}.`);
    return;
  }
  const tag = wanted ?? newestTag(source);
  const atNewest = () => console.log(`${name} is at its newest version, ${current.version}.`);
  if (!wanted && newer(current.version, tag.slice(1))) {
    atNewest();
    return;
  }
  const cloned = cloneTag(source, tag, commit);
  const { staged, manifest } = cloned;
  try {
    // The newest tag can be the installed version moved to another commit, which is an update
    // too, shown and asked about like any other.
    if (!wanted && manifest.version === current.version && cloned.commit === commitOf(folder)) {
      atNewest();
      return;
    }
    if (manifest.name !== name)
      throw new Error(`${source} now names its plugin ${manifest.name}, not ${name}`);
    checkSkelcrewVersion(manifest);
    if (ask && !confirmPlugin(manifest, source, "Update")) {
      console.log(`Skelcrew didn't update ${name}.`);
      return;
    }
    // The new version gets a folder beside the old one, which keeps working until the new
    // one is built and set up, and only then goes. A lock can move a plugin to another commit
    // of the same version, whose folder gets the commit in its name so the two stay apart.
    const versionFolder = join(pluginsDir(), name, manifest.version);
    const newFolder =
      versionFolder === folder ? `${versionFolder}-${cloned.commit.slice(0, 12)}` : versionFolder;
    rmSync(newFolder, { recursive: true, force: true });
    renameSync(staged, newFolder);
    try {
      buildAndSetUp(manifest, newFolder, true, remote);
    } catch (error) {
      rmSync(newFolder, { recursive: true, force: true });
      throw error;
    }
    db.run("UPDATE plugins SET folder = ? WHERE name = ?", [newFolder, name]);
    setLocked(db, source, lockedAs(manifest, cloned.commit));
    rmSync(folder, { recursive: true, force: true });
    console.log(`Updated ${name} from ${current.version} to ${manifest.version}.`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

// Updates the named plugin, or every one, for sc update -g. A plugin your files name that isn't
// installed here is installed at its newest version instead, after asking, so its lock moves
// too. `name` is a plugin's name or its owner/repo.
export function updatePlugins(name?: string): void {
  const db = openDb();
  const lock = yourLock(db);
  const installed = installedPlugins(db);
  const missing = yourPlugins().filter(
    (source) => !installed.some((plugin) => plugin.source === source),
  );
  const chosen = installed.filter(
    (plugin) => name === undefined || plugin.name === name || plugin.source === name,
  );
  const toInstall = missing.filter(
    (source) => name === undefined || source === name || lock[source]?.name === name,
  );
  if (name !== undefined && chosen.length + toInstall.length === 0)
    throw new Error(`there is no plugin named ${name}: sc plugins lists them`);
  if (chosen.length + toInstall.length === 0) console.log("No plugins installed.");
  for (const plugin of chosen) updatePlugin(db, plugin);
  for (const source of toInstall) installPlugin(source);
}

// Removes a plugin with its settings and tokens. A plugin from GitHub loses its folders and its
// line in your lock too, and a folder of yours stays. It refuses while the plugin is the tracker
// of a repository Skelcrew has, as that repository would lose its tasks, and while it is the forge
// of one, which would lose its PRs and its login for pushing.
export function removePlugin(name: string): void {
  const db = openDb();
  const plugin = findPlugin(db, name);
  // The repositories that use it as their tracker, then as their forge.
  for (const [job, usingIt] of [
    ["tracker", repositories(db).filter((r) => trackerOf(db, r) === name)],
    ["forge", repositories(db).filter((r) => r.forge === name)],
  ] as const)
    if (usingIt.length > 0)
      throw new Error(
        `${name} is the ${job} of ${usingIt.map((r) => r.name).join(", ")}, so Skelcrew keeps it`,
      );
  db.run("DELETE FROM plugins WHERE name = ?", [name]);
  if (plugin.source !== null) setLocked(db, plugin.source, null);
  // The settings folder is the one settingsDir makes.
  rmSync(join(configDir(), "plugins", name), { recursive: true, force: true });
  if (plugin.source !== null) rmSync(join(pluginsDir(), name), { recursive: true, force: true });
  console.log(`Removed ${name}, with its settings and tokens.`);
}

// Adds a personal plugin, for sc add -g: installs it after asking, then names it under plugins:
// in your config.yaml, beside the version your lock now pins. A folder of yours is only
// installed, as it has no version to pin. Returns whether it was installed.
export function addPlugin(given: string, remote = originHere()): boolean {
  if (!installPlugin(given, { remote })) return false;
  if (given.startsWith(".") || given.startsWith("/")) return true;
  setYourPlugins([...yourPlugins().filter((source) => source !== given), given]);
  return true;
}

// Removes a personal plugin, for sc remove -g: from plugins: in your config.yaml, from your lock
// and from this machine, with its settings and tokens. `given` is its name or its owner/repo. It
// refuses while the plugin is the tracker or forge of a repository Skelcrew has, and then changes
// nothing.
export function removeYourPlugin(given: string): void {
  const db = openDb();
  const lock = yourLock(db);
  const installed = installedPlugins(db).find(
    (plugin) => plugin.name === given || plugin.source === given,
  );
  // A plugin your files name may not be installed here yet, so the lock names it too.
  const source =
    installed?.source ??
    yourPlugins().find((one) => one === given || lock[one]?.name === given) ??
    null;
  if (!installed && source === null)
    throw new Error(`there is no plugin named ${given}: sc plugins lists them`);
  if (installed) removePlugin(installed.name);
  if (source === null) return;
  setYourPlugins(yourPlugins().filter((one) => one !== source));
  setLocked(db, source, null);
  if (!installed) console.log(`Removed ${given} from your plugins.`);
}

// Returns whether the plugin is installed at exactly the version and commit locked.
function matchesLock(plugin: Plugin, locked: Locked): boolean {
  return (
    readManifest(plugin.folder).version === locked.version &&
    commitOf(plugin.folder) === locked.commit
  );
}

// Makes this machine match your personal files, for sc install: installs each plugin under
// plugins: in your config.yaml at the version and commit your lock pins, or at its newest version
// tag when the lock has none yet. A plugin new here, or at another version or commit, is shown and
// asked about. One already at its locked version asks nothing, as you approved it before. Returns
// whether there was anything to do. `remote` is handed to each setup.
export function installYourPlugins(remote: string | null): boolean {
  const db = openDb();
  const lock = yourLock(db);
  let changed = false;
  for (const source of yourPlugins()) {
    const locked = lock[source];
    const here = installedPlugins(db).find((plugin) => plugin.source === source);
    // A plugin installed before your lock named it is pinned as it is, with nothing to ask.
    if (here && !locked) {
      setLocked(db, source, lockedAs(readManifest(here.folder), commitOf(here.folder)));
      continue;
    }
    if (here && locked && matchesLock(here, locked)) continue;
    changed = true;
    const pinned = locked ? { tag: `v${locked.version}`, commit: locked.commit } : {};
    if (here) updatePlugin(db, here, { ...pinned, remote });
    else installPlugin(source, { ...pinned, remote });
  }
  return changed;
}

// One row of sc plugins: a plugin your files name or this machine has. The version, kind and
// what it provides are the installed one's, or with none installed, the version locked. `from`
// is where it comes from, and `change` what sc install would do to it, or null for nothing.
type Row = {
  name: string;
  version: string | null;
  kind: string | null;
  provides: string[];
  from: string;
  change: string | null;
};

// Prints the plugins your files name and this machine has, for sc plugins: each one's name,
// version, kind and what it provides, such as "github 0.1.0 io: tracker, forge", and what sc
// install would change. --json gives the same rows for tools.
export function listPlugins(json: boolean): void {
  const db = openDb();
  const lock = yourLock(db);
  const wanted = yourPlugins();
  const installed = installedPlugins(db);
  const rows: Row[] = installed.map((plugin) => {
    const manifest = existsSync(plugin.folder) ? readManifest(plugin.folder) : null;
    if (!manifest) throw new Error(`${plugin.name}'s folder ${plugin.folder} is gone`);
    const locked = plugin.source === null ? undefined : lock[plugin.source];
    // Only a plugin your files name has a version for sc install to move it to.
    const moves =
      plugin.source !== null &&
      wanted.includes(plugin.source) &&
      locked &&
      !matchesLock(plugin, locked);
    const to =
      locked?.version === manifest.version
        ? `${locked.version} at commit ${locked.commit.slice(0, 12)}`
        : locked?.version;
    return {
      name: plugin.name,
      version: manifest.version,
      kind: manifest.kind,
      provides: manifest.provides,
      from: plugin.source ?? plugin.folder,
      change: moves ? `sc install moves it to ${to}` : null,
    };
  });
  // The plugins your files name that aren't installed here.
  for (const source of wanted) {
    if (installed.some((plugin) => plugin.source === source)) continue;
    const locked = lock[source];
    rows.push({
      name: locked?.name ?? source,
      version: locked?.version ?? null,
      kind: null,
      provides: [],
      from: source,
      change: locked ? "sc install installs it" : "sc install installs its newest version",
    });
  }
  // Plain text gives only what you read. JSON adds where each came from, for tools.
  if (json) console.log(JSON.stringify(rows));
  else if (rows.length === 0) console.log("No plugins installed.");
  else
    for (const row of rows)
      console.log(
        row.kind === null
          ? `${row.name}${row.version ? ` ${row.version}` : ""} from ${row.from} isn't installed. ${row.change}.`
          : `${row.name} ${row.version} ${row.kind}: ${row.provides.join(", ")}${row.change ? `. ${row.change}.` : ""}`,
      );
}
