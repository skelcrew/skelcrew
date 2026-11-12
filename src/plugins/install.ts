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
import { removeControlCodes } from "../screen/look.ts";
import { release } from "../version.ts";
import { trackerOf } from "./ask.ts";
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

// Clones a GitHub repository at a version tag into a temporary folder beside the installed
// plugins. Returns that folder and its manifest, once the manifest's version matches the tag. The
// caller moves the folder into place only after you agree, so a clone stopped halfway never looks
// like a plugin.
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
function checkSkelcrewVersion(manifest: Manifest): void {
  if (release && newer(manifest.skelcrew, release))
    throw new Error(
      `${manifest.name} ${manifest.version} needs Skelcrew ${manifest.skelcrew} or newer, and this is Skelcrew ${release}`,
    );
}

// Warns in one line that the plugin runs as you, outside the sandbox, and asks whether to `verb`
// it, such as Install. Returns whether you said yes. A plugin runs with your rights, so nothing
// of it runs before you say yes.
function confirmPlugin(manifest: Manifest, from: string, verb: string): boolean {
  const { name, version } = manifest;
  // Bun's prompt answers a bare Enter with null, which is no, as the question says.
  const answer = prompt(
    `${name} ${version} from ${removeControlCodes(from)} runs as you, outside Skelcrew's sandbox. ${verb} it? [y/N]`,
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
// would do it too, but would fetch and build the plugin again for nothing. sc plugin setup
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
  if (manifest.jobs.includes("forge"))
    db.run("UPDATE repositories SET claimed = 0 WHERE forge IS NULL");
}

// Throws when a plugin of that name is installed already, as one name can't be two plugins.
function refuseInstalled(db: Database, name: string): void {
  if (installedPlugins(db).some((plugin) => plugin.name === name))
    throw new Error(`${name} is installed already: run sc plugin update ${name}`);
}

// Installs a plugin, for sc plugin install. `given` is either owner/repo, installed from that
// GitHub repository's newest version tag, or a path to a folder of yours, used where it is. It
// warns that the plugin runs outside the sandbox and asks first. Then it runs the plugin's build
// and setup, handing them `remote`, the checkout's remote. When sc offered to install a plugin
// from GitHub, you said yes already, so `ask` is false and it only says what it installs.
export function installPlugin(given: string, remote = originHere(), ask = true): void {
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
      return;
    }
    buildAndSetUp(manifest, folder, true, remote);
    db.run("INSERT INTO plugins (name, folder, source) VALUES (?, ?, NULL)", [
      manifest.name,
      folder,
    ]);
    markUnclaimed(db, manifest);
    console.log(`Installed ${manifest.name} ${manifest.version}.`);
    return;
  }
  // A name starting with a dash would reach git as an option.
  if (!/^[\w.][\w.-]*\/[\w.-]+$/.test(given))
    throw new Error(`${given} is neither a folder, such as ./skelcrew-linear, nor owner/repo`);
  // Nothing of the clone runs before the checks and your yes.
  const { staged, manifest } = cloneTag(given, newestTag(given));
  try {
    refuseInstalled(db, manifest.name);
    checkSkelcrewVersion(manifest);
    if (!ask) console.log(`Installing ${manifest.name} ${manifest.version} from ${given}...`);
    else if (!confirmPlugin(manifest, given, "Install")) {
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
    markUnclaimed(db, manifest);
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
    checkSkelcrewVersion(manifest);
    if (!confirmPlugin(manifest, source, "Update")) {
      console.log(`Skelcrew didn't update ${name}.`);
      return;
    }
    // The new version gets a folder beside the old one, which keeps working until the new
    // one is built and set up, and only then goes.
    const newFolder = join(pluginsDir(), name, manifest.version);
    rmSync(newFolder, { recursive: true, force: true });
    renameSync(staged, newFolder);
    try {
      buildAndSetUp(manifest, newFolder, true, originHere());
    } catch (error) {
      rmSync(newFolder, { recursive: true, force: true });
      throw error;
    }
    db.run("UPDATE plugins SET folder = ? WHERE name = ?", [newFolder, name]);
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
// loses its folders too, and a folder of yours stays. It refuses while the plugin is the tracker
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
