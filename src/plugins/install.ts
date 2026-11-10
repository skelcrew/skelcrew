// skel plugin: installing a plugin from its newest version tag on GitHub or from a folder of
// yours, updating, removing and listing plugins. Only you run these, in your own terminal.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDb } from "../db.ts";
import { repositories } from "../flow/repo.ts";
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
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// Returns the newest version tag of a GitHub repository, such as v0.2.0, asking GitHub only
// for its tags. Tags that aren't versions are passed over.
function newestTag(source: string): string {
  const listed = Bun.spawnSync(
    ["git", "ls-remote", "--tags", "--refs", `https://github.com/${source}`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (!listed.success)
    throw new Error(`git couldn't reach ${source} on GitHub: ${listed.stderr.toString().trim()}`);
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
  try {
    const manifest = readManifest(staged);
    if (`v${manifest.version}` !== tag)
      throw new Error(
        `${source} isn't installable: its tag ${tag} says ${tag.slice(1)}, and its skel-plugin.yaml ${manifest.version}`,
      );
    return { staged, manifest };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

// Throws when the plugin needs a newer skel than this one. A build from a checkout has no
// release to compare, and takes any plugin.
function fitsThisSkel(manifest: Manifest): void {
  if (release && newer(manifest.skel, release))
    throw new Error(
      `${manifest.name} ${manifest.version} needs skel ${manifest.skel} or newer, and this is skel ${release}`,
    );
}

// Shows what the plugin is and every command it will run as you, then asks whether to go on,
// as `verb`, such as Install. Returns whether you said yes. A plugin runs outside the sandbox
// with your rights, so nothing of it runs before you have seen this.
function agreed(manifest: Manifest, from: string, verb: string): boolean {
  const { name, version, about, jobs } = manifest;
  console.log(`${name} ${version}, from ${from}`);
  console.log(clean(about));
  console.log(`Jobs: ${jobs.join(", ")}`);
  console.log("It runs these commands as you, outside skel's sandbox:");
  const commands = [
    ...(manifest.build ?? []).map((words) => ["build", words] as const),
    ...(["setup", "call", "git_credentials", "add", "exec", "push"] as const).flatMap((key) => {
      const words = manifest[key];
      return words ? [[key, words] as const] : [];
    }),
  ];
  for (const [key, words] of commands) console.log(`  ${key}: ${clean(words.join(" "))}`);
  const answer = prompt(`${verb} ${name}? [y/N]`);
  return ["y", "yes"].includes(answer?.trim().toLowerCase() ?? "");
}

// Runs a plugin's build commands, then its setup in your terminal, in the plugin's folder.
// Throws when one fails.
function buildAndSetUp(manifest: Manifest, folder: string, setup: boolean): void {
  const commands = [
    ...(manifest.build ?? []),
    ...(setup && manifest.setup ? [manifest.setup] : []),
  ];
  for (const words of commands) {
    const { argv, env } = commandFor(manifest.name, words);
    const run = Bun.spawnSync(argv, {
      cwd: folder,
      env: { ...process.env, ...env },
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (!run.success) throw new Error(`${manifest.name}'s ${clean(words.join(" "))} failed`);
  }
}

// Has skel ask again which forge claims each repository that has none, once a forge is
// installed, so a repository added before it gains it.
function askAgain(db: Database, manifest: Manifest): void {
  if (manifest.jobs.includes("forge"))
    db.run("UPDATE repositories SET claimed = 0 WHERE forge IS NULL");
}

// Throws when a plugin of that name is installed already, as one name can't be two plugins.
function refuseInstalled(db: Database, name: string): void {
  if (installedPlugins(db).some((plugin) => plugin.name === name))
    throw new Error(`${name} is installed already: run skel plugin update ${name}`);
}

// Installs a plugin, for skel plugin install: from the newest version tag of a GitHub
// repository, given as owner/repo, or from a folder of yours, given as a path, used where it
// is. It shows what the plugin runs and asks first, then runs its build and setup.
export function installPlugin(given: string): void {
  const db = openDb();
  const isPath = given.startsWith(".") || given.startsWith("/");
  if (isPath) {
    const folder = realpathSync(resolve(given));
    const manifest = readManifest(folder);
    refuseInstalled(db, manifest.name);
    fitsThisSkel(manifest);
    if (!agreed(manifest, folder, "Install")) {
      console.log(`skel didn't install ${manifest.name}.`);
      return;
    }
    buildAndSetUp(manifest, folder, true);
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
  const { staged, manifest } = cloneTag(given, newestTag(given));
  try {
    refuseInstalled(db, manifest.name);
    fitsThisSkel(manifest);
    if (!agreed(manifest, given, "Install")) {
      console.log(`skel didn't install ${manifest.name}.`);
      return;
    }
    const folder = join(pluginsDir(), manifest.name, manifest.version);
    rmSync(dirname(folder), { recursive: true, force: true });
    mkdirSync(dirname(folder), { recursive: true });
    renameSync(staged, folder);
    try {
      buildAndSetUp(manifest, folder, true);
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
    rmSync(staged, { recursive: true, force: true });
  }
}

// Updates one plugin. One from a folder is built again from it, so your edits count. One from
// GitHub moves to its newest version tag, after showing what it runs and asking, as installing
// does, and its old version's folder goes.
function updatePlugin(db: Database, plugin: Plugin): void {
  const { name, folder, source } = plugin;
  const current = readManifest(folder);
  if (source === null) {
    buildAndSetUp(current, folder, false);
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
      console.log(`skel didn't update ${name}.`);
      return;
    }
    const moved = join(pluginsDir(), name, manifest.version);
    rmSync(moved, { recursive: true, force: true });
    renameSync(staged, moved);
    try {
      buildAndSetUp(manifest, moved, true);
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

// Updates the named plugin, or every one, for skel plugin update.
export function updatePlugins(name?: string): void {
  const db = openDb();
  const chosen = name ? [findPlugin(db, name)] : installedPlugins(db);
  if (chosen.length === 0) console.log("No plugins installed.");
  for (const plugin of chosen) updatePlugin(db, plugin);
}

// Removes a plugin with its settings and tokens, for skel plugin rm. A plugin from GitHub
// loses its folders too, and a folder of yours stays. It refuses while a repository skel has
// names the plugin as its tracker in skel.yaml, as that repository would lose its tasks, and
// while it is the forge of one, which would lose its PRs and its login for pushing.
export function removePlugin(name: string): void {
  const db = openDb();
  const plugin = findPlugin(db, name);
  for (const [job, those] of [
    ["tracker", trackedBy(db, name)],
    ["forge", repositories(db).filter((r) => r.forge === name)],
  ] as const)
    if (those.length > 0)
      throw new Error(
        `${name} is the ${job} of ${those.map((r) => r.name).join(", ")}, so skel keeps it`,
      );
  db.run("DELETE FROM plugins WHERE name = ?", [name]);
  rmSync(join(configDir(), "plugins", name), { recursive: true, force: true });
  if (plugin.source !== null) rmSync(join(pluginsDir(), name), { recursive: true, force: true });
  console.log(`Removed ${name}, with its settings and tokens.`);
}

// Prints the installed plugins, for skel plugin ls: each one's name, version and jobs, such
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
  if (json) console.log(JSON.stringify(rows));
  else if (rows.length === 0) console.log("No plugins installed.");
  else for (const row of rows) console.log(`${row.name} ${row.version} ${row.jobs.join(", ")}`);
}
