// sc plugin: installing a plugin from its newest version tag on GitHub or from a folder of yours,
// updating, setting up again, removing and listing plugins. Only you run these, in your own
// terminal.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDb } from "../db.ts";
import { repositories } from "../flow/repo.ts";
import { originHere } from "../machine/origin.ts";
import { configDir, dataDir } from "../paths.ts";
import { clean } from "../screen/look.ts";
import { release } from "../version.ts";
import {
  commandFor,
  findPlugin,
  installedPlugins,
  type Manifest,
  type Plugin,
  readManifest,
  trackedBy,
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

// Clones a GitHub repository at a version tag beside the installed plugins, and returns the
// folder and its manifest, checked against the tag. A clone stopped halfway must not look like
// a plugin, so it is moved into place only once you agree.
function cloneTag(source: string, tag: string): { staged: string; manifest: Manifest } {
  // Staged beside the plugins, so a rename moves it into place. A name starting with a dot
  // can't be a plugin's.
  const staged = join(pluginsDir(), `.cloning-${process.pid}`);
  mkdirSync(pluginsDir(), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  const cloned = Bun.spawnSync(
    ["git", "-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1"].concat([
      "--branch",
      tag,
      `https://github.com/${source}`,
      staged,
    ]),
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (!cloned.success)
    throw new Error(`git couldn't clone ${source} at ${tag}: ${cloned.stderr.toString().trim()}`);
  // A tag that disagrees with its manifest is refused, so the version you were told is the
  // one that runs.
  try {
    const manifest = readManifest(staged);
    if (`v${manifest.version}` !== tag)
      throw new Error(
        `${source} isn't installable: its tag ${tag} says ${tag.slice(1)}, and its skelcrew-plugin.yaml ${manifest.version}`,
      );
    return { staged, manifest };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

// Throws when the plugin needs a newer Skelcrew than this one. A build from a checkout has no
// release to compare, and takes any plugin.
function fitsThisSkel(manifest: Manifest): void {
  if (release && newer(manifest.skelcrew, release))
    throw new Error(
      `${manifest.name} ${manifest.version} needs Skelcrew ${manifest.skelcrew} or newer, and this is Skelcrew ${release}`,
    );
}

// Says in one line that the plugin runs as you, outside the sandbox, then asks whether to go on,
// as `verb`, such as Install. Returns whether you said yes. A plugin runs with your rights, so
// nothing of it runs before you have said yes.
function agreed(manifest: Manifest, from: string, verb: string): boolean {
  const { name, version } = manifest;
  // Bun's prompt answers a bare Enter with null, which is no, as the question says.
  const answer = prompt(
    `${name} ${version} from ${clean(from)} runs as you, outside Skelcrew's sandbox. ${verb} it? [y/N]`,
  );
  return ["y", "yes"].includes(answer?.trim().toLowerCase() ?? "");
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
  if (!run.success) throw new Error(`${manifest.name}'s ${clean(words.join(" "))} failed`);
}

// Runs a plugin's build commands, then its setup, in the plugin's folder, handing each the
// remote of the checkout sc ran in. Throws when one fails.
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

// Runs an installed plugin's setup again in your terminal, for sc plugin setup, such as to
// sign in again once its sign-in has lapsed. Reinstalling would do it too, but would fetch and
// build the plugin again for nothing.
export function setUpPlugin(name: string): void {
  const { folder } = findPlugin(openDb(), name);
  const manifest = readManifest(folder);
  if (!manifest.setup) throw new Error(`${name} has no setup to run`);
  runInTerminal(manifest, folder, manifest.setup, originHere());
  console.log(`Ran ${name}'s setup.`);
}

// Has Skelcrew ask again which forge claims each repository that has none, once a forge is
// installed, so a repository added before it gains it.
function askAgain(db: Database, manifest: Manifest): void {
  if (manifest.jobs.includes("forge"))
    db.run("UPDATE repositories SET claimed = 0 WHERE forge IS NULL");
}

// Throws when a plugin of that name is installed already, as one name can't be two plugins.
function refuseInstalled(db: Database, name: string): void {
  if (installedPlugins(db).some((plugin) => plugin.name === name))
    throw new Error(`${name} is installed already: run sc plugin update ${name}`);
}

// Installs a plugin, for sc plugin install: from the newest version tag of a GitHub
// repository, given as owner/repo, or from a folder of yours, given as a path, used where it
// is. It warns that the plugin runs outside the sandbox and asks first, then runs its build and
// setup, handing them `remote`, the checkout's remote. When sc offered the plugin itself, you
// said yes to that offer already, so `ask` is false and it only says what it installs.
export function installPlugin(given: string, remote = originHere(), ask = true): void {
  const db = openDb();
  const isPath = given.startsWith(".") || given.startsWith("/");
  // A folder of yours is used where it is, found by its real path so a link that moves later
  // doesn't move the plugin.
  if (isPath) {
    const folder = realpathSync(resolve(given));
    const manifest = readManifest(folder);
    refuseInstalled(db, manifest.name);
    fitsThisSkel(manifest);
    if (!agreed(manifest, folder, "Install")) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return;
    }
    buildAndSetUp(manifest, folder, true, remote);
    db.run("INSERT INTO plugins (name, folder, source) VALUES (?, ?, NULL)", [
      manifest.name,
      folder,
    ]);
    askAgain(db, manifest);
    console.log(`Installed ${manifest.name} ${manifest.version}.`);
    return;
  }
  // A name starting with a dash would reach git as an option.
  if (!/^[\w.][\w.-]*\/[\w.-]+$/.test(given))
    throw new Error(`${given} is neither a folder, such as ./skel-plugin-linear, nor owner/repo`);
  // Nothing of the clone runs before the checks and your yes.
  const { staged, manifest } = cloneTag(given, newestTag(given));
  try {
    refuseInstalled(db, manifest.name);
    fitsThisSkel(manifest);
    if (!ask) console.log(`Installing ${manifest.name} ${manifest.version} from ${given}...`);
    else if (!agreed(manifest, given, "Install")) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return;
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
    askAgain(db, manifest);
    console.log(`Installed ${manifest.name} ${manifest.version}.`);
  } finally {
    // Only a clone that never moved into place is still there.
    rmSync(staged, { recursive: true, force: true });
  }
}

// Updates one plugin. One from a folder is built again from it, so your edits count. One from
// GitHub moves to its newest version tag, after warning and asking, as installing
// does, and its old version's folder goes.
function updatePlugin(db: Database, plugin: Plugin): void {
  const { name, folder, source } = plugin;
  const current = readManifest(folder);
  // A folder of yours gets only its build again. Its setup is for sc plugin setup.
  if (source === null) {
    buildAndSetUp(current, folder, false, originHere());
    console.log(`Built ${name} ${current.version} again from ${folder}.`);
    return;
  }
  const tag = newestTag(source);
  if (!newer(tag.slice(1), current.version)) {
    console.log(`${name} is at its newest version, ${current.version}.`);
    return;
  }
  const { staged, manifest } = cloneTag(source, tag);
  try {
    if (manifest.name !== name)
      throw new Error(`${source} now names its plugin ${manifest.name}, not ${name}`);
    fitsThisSkel(manifest);
    if (!agreed(manifest, source, "Update")) {
      console.log(`Skelcrew didn't update ${name}.`);
      return;
    }
    // The new version gets a folder beside the old one, which keeps working until the new
    // one is built and set up, and only then goes.
    const moved = join(pluginsDir(), name, manifest.version);
    rmSync(moved, { recursive: true, force: true });
    renameSync(staged, moved);
    try {
      buildAndSetUp(manifest, moved, true, originHere());
    } catch (error) {
      rmSync(moved, { recursive: true, force: true });
      throw error;
    }
    db.run("UPDATE plugins SET folder = ? WHERE name = ?", [moved, name]);
    rmSync(folder, { recursive: true, force: true });
    console.log(`Updated ${name} from ${current.version} to ${manifest.version}.`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

// Updates the named plugin, or every one, for sc plugin update.
export function updatePlugins(name?: string): void {
  const db = openDb();
  const chosen = name ? [findPlugin(db, name)] : installedPlugins(db);
  if (chosen.length === 0) console.log("No plugins installed.");
  for (const plugin of chosen) updatePlugin(db, plugin);
}

// Removes a plugin with its settings and tokens, for sc plugin rm. A plugin from GitHub
// loses its folders too, and a folder of yours stays. It refuses while a repository Skelcrew has
// names the plugin as its tracker in skelcrew.yaml, as that repository would lose its tasks, and
// while it is the forge of one, which would lose its PRs and its login for pushing.
export function removePlugin(name: string): void {
  const db = openDb();
  const plugin = findPlugin(db, name);
  // The repositories that use it as their tracker, then as their forge.
  for (const [job, those] of [
    ["tracker", trackedBy(db, name)],
    ["forge", repositories(db).filter((r) => r.forge === name)],
  ] as const)
    if (those.length > 0)
      throw new Error(
        `${name} is the ${job} of ${those.map((r) => r.name).join(", ")}, so Skelcrew keeps it`,
      );
  db.run("DELETE FROM plugins WHERE name = ?", [name]);
  // The settings folder is the one settingsDir makes.
  rmSync(join(configDir(), "plugins", name), { recursive: true, force: true });
  if (plugin.source !== null) rmSync(join(pluginsDir(), name), { recursive: true, force: true });
  console.log(`Removed ${name}, with its settings and tokens.`);
}

// Prints the installed plugins, for sc plugin ls: each one's name, version and jobs, such
// as "github 0.1.0 tracker, forge", or as JSON for tools, with where each one came from.
export function listPlugins(json: boolean): void {
  const rows = installedPlugins(openDb()).map((plugin) => {
    const manifest = existsSync(plugin.folder) ? readManifest(plugin.folder) : null;
    if (!manifest) throw new Error(`${plugin.name}'s folder ${plugin.folder} is gone`);
    return {
      name: plugin.name,
      version: manifest.version,
      jobs: manifest.jobs,
      from: plugin.source ?? plugin.folder,
    };
  });
  // Plain text gives only what you read. JSON adds where each came from, for tools.
  if (json) console.log(JSON.stringify(rows));
  else if (rows.length === 0) console.log("No plugins installed.");
  else for (const row of rows) console.log(`${row.name} ${row.version} ${row.jobs.join(", ")}`);
}
