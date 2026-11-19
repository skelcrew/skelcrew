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
import { z } from "zod";
import { openDb } from "../db.ts";
import { repositories } from "../flow/repo.ts";
import { originHere } from "../machine/origin.ts";
import { configDir, dataDir } from "../paths.ts";
import { removeControlCodes } from "../screen/look.ts";
import { release } from "../version.ts";
import { trackerOf } from "./ask.ts";
import {
  type Locked,
  setLocked,
  setYourPlugins,
  writeBoth,
  yourLock,
  yourPlugins,
} from "./lock.ts";
import {
  commandFor,
  commitOf,
  findPlugin,
  installedPlugins,
  type Manifest,
  type Plugin,
  readManifest,
  Version,
} from "./plugin.ts";
import type { Need } from "./repository.ts";

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
    const said = (run: { stderr: Buffer }) => run.stderr.toString().trim();
    // Whatever fails here is the machine's own git, not the forge.
    const local = (run: { stderr: Buffer }) => {
      rmSync(staged, { recursive: true, force: true });
      return new Error(`git failed in ${staged}: ${said(run)}`);
    };
    const made = git(["init", "--quiet", staged]);
    if (!made.success) throw local(made);
    const fetched = git(["-C", staged, "fetch", "--quiet", "--depth", "1", url, commit]);
    if (fetched.success) {
      const checkedOut = git(["-C", staged, "checkout", "--quiet", "FETCH_HEAD"]);
      if (!checkedOut.success) throw local(checkedOut);
    } else {
      // A forge can refuse to serve a commit by its id. Then the tag is cloned, which is only
      // the locked code while the tag still points at that commit.
      rmSync(staged, { recursive: true, force: true });
      const cloned = git(["clone", "--quiet", "--depth", "1", "--branch", tag, url, staged]);
      // With the tag out of reach too, the repository can't be reached, such as with no
      // network or no login, which says nothing of whether the commit is still there.
      if (!cloned.success) {
        rmSync(staged, { recursive: true, force: true });
        throw new Error(
          `git couldn't reach commit ${commit.slice(0, 12)} of ${source}, which your lock pins: ${said(fetched)}. Nor its tag ${tag}: ${said(cloned)}`,
        );
      }
      // The repository answered, refused the commit and moved the tag, so it doesn't serve that
      // commit any more. Only sc update -g can move your lock past it.
      const at = commitOf(staged);
      if (at !== commit) {
        rmSync(staged, { recursive: true, force: true });
        throw new Error(
          `${source} no longer serves commit ${commit.slice(0, 12)}, which your lock pins: git couldn't fetch it (${said(fetched)}), and its tag ${tag} is at ${at.slice(0, 12)} now. sc update -g moves it to its newest version, after showing what it runs`,
        );
      }
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
    console.log(`${question} There is no terminal to answer in.`);
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

// Returns every command a plugin's manifest runs, each as its list of words, in the order sc
// shows them when it asks.
function commandsOf(manifest: Manifest): string[][] {
  const { build = [], setup, call, git_credentials, add, exec, push, session, attach } = manifest;
  return [...build, setup, call, git_credentials, add, exec, push, session, attach].filter(
    (words) => words !== undefined,
  );
}

// Returns what you approve of a plugin as text to keep: each command under the manifest field it
// comes from, with its words apart. A folder plugin's is kept as you approved it, so building it
// again asks only once it changes. Words joined with spaces would let ["sh", "a b"] pass for
// ["sh", "a", "b"], and a list without the fields would let a command move to another field.
function approvalOf(manifest: Manifest): string {
  const { build, setup, call, git_credentials, add, exec, push, session, attach } = manifest;
  return JSON.stringify({ build, setup, call, git_credentials, add, exec, push, session, attach });
}

// Returns one word of a command as a shell would need it typed: as it is when it holds only
// plain characters, and in single quotes otherwise. Shown so, ["sh", "a b"] reads sh 'a b' and
// can't be taken for ["sh", "a", "b"], which runs differently.
const shellWord = (word: string) =>
  /^[\w./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

// Shows what the plugin is and runs, and asks whether to `verb` it, such as Install. It says the
// plugin's name, source, version, kind, what it provides and every command its manifest runs, as
// it runs as you, outside the sandbox. Returns true for yes, false for any other answer, and null
// with no terminal to answer in. Nothing of the plugin runs before this.
function confirmPlugin(manifest: Manifest, from: string, verb: string): boolean | null {
  const { name, version, kind, provides } = manifest;
  const kindName = kind === "io" ? "an I/O" : "a runtime";
  const commands = commandsOf(manifest).map(
    (words) => `  ${removeControlCodes(words.map(shellWord).join(" "))}`,
  );
  console.log(
    `${name} ${version} from ${removeControlCodes(from)} is ${kindName} plugin that provides ${provides.join(", ")}. It runs these as you, outside Skelcrew's sandbox:\n${commands.join("\n")}`,
  );
  return askYes(`${verb} it? [Y/n]`);
}

// The error for a plugin's commands that would run with no terminal to answer whether they may.
// It fails the command, so a script that runs sc install can tell the machine doesn't match your
// files yet. A class of its own lets sc install and sc update -g go on to the other plugins and
// name every one left out.
class Unanswered extends Error {}

// Returns that error for `doing`, such as "installing fake".
const unanswered = (doing: string) =>
  new Unanswered(
    `${doing} runs its commands, which needs your yes at a terminal, so Skelcrew didn't run them`,
  );

// Runs `change` for each plugin, and fails at the end naming each one left out for want of a
// terminal to say yes at, by the name `nameOf` gives. Any other error stops at once, as for a
// single plugin.
export function eachAsked<T>(
  plugins: T[],
  nameOf: (plugin: T) => string,
  change: (plugin: T) => void,
): void {
  const leftOut: string[] = [];
  for (const plugin of plugins)
    try {
      change(plugin);
    } catch (error) {
      if (!(error instanceof Unanswered)) throw error;
      leftOut.push(nameOf(plugin));
    }
  if (leftOut.length > 0)
    throw new Error(
      `Skelcrew left out ${leftOut.join(", ")}, as each runs its commands, which needs your yes at a terminal. Run it again at one`,
    );
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
// setup a server takes. `tag` picks the version, such as v0.1.0, in place of the newest, and
// `commit` the exact commit to fetch. `pin` is false when the commit came from your lock, which
// sc install leaves as it is, and `name` true to add the plugin to plugins: in your config.yaml.
// `io` is true for a repository's plugin, which must be an I/O plugin, and `called` the name a
// repository's lock gives it, which its manifest must give too.
type Options = {
  remote?: string | null;
  ask?: boolean;
  tag?: string;
  commit?: string;
  pin?: boolean;
  name?: boolean;
  io?: boolean;
  called?: string;
};

// Throws when the plugin's manifest names it otherwise than the lock that pins it, `called`, before
// anything of it runs. The lock says which plugin you get, so another one is never taken for it.
export function refuseOtherName(manifest: Manifest, called: string | undefined): void {
  if (called !== undefined && manifest.name !== called)
    throw new Error(
      `the lock pins ${called}, and the plugin there is ${manifest.name}, so Skelcrew won't take one for the other`,
    );
}

// Throws when `io` is true and the plugin is a runtime plugin, before anything of it runs. How you
// run and watch your agents is yours, so only you add a runtime plugin, and a repository's files
// can't name one.
export function refuseRuntime(manifest: Manifest, io: boolean | undefined): void {
  if (io && manifest.kind === "runtime")
    throw new Error(
      `${manifest.name} is a runtime plugin, which is always yours and never a repository's. sc add -g adds it as yours`,
    );
}

// Installs a plugin and returns whether it did. `given` is either owner/repo, installed from that
// GitHub repository's newest version tag or the one `tag` names, or a path to a folder of yours,
// used where it is. It shows what the plugin runs and asks first. Then it runs the plugin's build
// and setup, and writes your files as `pin` and `name` say, before the plugin counts as
// installed. A write that fails leaves the files as they were and the plugin not installed.
export function installPlugin(given: string, options: Options = {}): boolean {
  const { ask = true, tag, commit, pin = true, name = false, io, called } = options;
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
    const answer = confirmPlugin(manifest, folder, "Install");
    if (answer === null) throw unanswered(`installing ${manifest.name}`);
    if (!answer) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return false;
    }
    buildAndSetUp(manifest, folder, true, remote);
    db.run("INSERT INTO plugins (name, folder, source, approved) VALUES (?, ?, NULL, ?)", [
      manifest.name,
      folder,
      approvalOf(manifest),
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
    refuseRuntime(manifest, io);
    refuseOtherName(manifest, called);
    const answer = ask ? confirmPlugin(manifest, given, "Install") : true;
    if (answer === null) throw unanswered(`installing ${manifest.name}`);
    if (!answer) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return false;
    }
    if (!ask) console.log(`Installing ${manifest.name} ${manifest.version} from ${given}...`);
    // Anything left of an earlier install of the name goes, as the plugin isn't installed.
    const folder = join(pluginsDir(), manifest.name, manifest.version);
    rmSync(dirname(folder), { recursive: true, force: true });
    mkdirSync(dirname(folder), { recursive: true });
    renameSync(staged, folder);
    // A build, setup or write of your files that fails takes the plugin's folder with it, so
    // nothing half installed stays.
    try {
      buildAndSetUp(manifest, folder, true, remote);
      writeBoth(() => {
        if (name) setYourPlugins([...yourPlugins().filter((one) => one !== given), given]);
        if (pin) setLocked(db, given, lockedAs(manifest, cloned.commit));
      });
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
    return true;
  } finally {
    // Only a clone that never moved into place is still there.
    rmSync(staged, { recursive: true, force: true });
  }
}

// Returns how the lock pins a plugin at this manifest's version and this commit.
export const lockedAs = (manifest: Manifest, commit: string): Locked => ({
  name: manifest.name,
  version: manifest.version,
  commit,
});

// Updates one plugin. One from a folder is built again from it, so your edits count. One from
// GitHub moves to its newest version tag, or to the one `tag` names at the lock's `commit`, after
// showing what it runs and asking, as installing does. Its old version's folder goes, and your
// lock pins the new one, unless `pin` is false.
export function updatePlugin(db: Database, plugin: Plugin, options: Options = {}): void {
  const { ask = true, tag: wanted, commit, pin = true, io, called } = options;
  const remote = options.remote === undefined ? originHere() : options.remote;
  const { name, folder, source } = plugin;
  const current = readManifest(folder);
  // A folder of yours gets only its build again. When its commands differ from those you
  // approved, it shows what it runs now and asks first. Its setup is for sc setup.
  if (source === null) {
    const commands = approvalOf(current);
    const row = db.query("SELECT approved FROM plugins WHERE name = ?").get(name);
    const approved = z.object({ approved: z.string().nullable() }).parse(row).approved;
    const answer = ask && commands !== approved ? confirmPlugin(current, folder, "Build") : true;
    if (answer === null) throw unanswered(`building ${name} again`);
    if (!answer) {
      console.log(`Skelcrew didn't build ${name} again.`);
      return;
    }
    buildAndSetUp(current, folder, false, originHere());
    db.run("UPDATE plugins SET approved = ? WHERE name = ?", [commands, name]);
    console.log(`Built ${name} ${current.version} again from ${folder}.`);
    return;
  }
  const tag = wanted ?? newestTag(source);
  // At its newest version, the lock is pinned at what is installed, as a lock copied from
  // another machine can pin an older one, which sc install would otherwise move back to.
  const atNewest = () => {
    setLocked(db, source, lockedAs(current, commitOf(folder)));
    console.log(`${name} is at its newest version, ${current.version}.`);
  };
  const cloned = cloneTag(source, tag, commit);
  const { staged, manifest } = cloned;
  try {
    // The newest tag can be the installed version moved to another commit, or an older version
    // when a newer tag was deleted. Either is a change, shown and asked about like any other.
    if (!wanted && manifest.version === current.version && cloned.commit === commitOf(folder)) {
      atNewest();
      return;
    }
    if (manifest.name !== name)
      throw new Error(`${source} now names its plugin ${manifest.name}, not ${name}`);
    checkSkelcrewVersion(manifest);
    refuseRuntime(manifest, io);
    refuseOtherName(manifest, called);
    const answer = ask ? confirmPlugin(manifest, source, "Update") : true;
    if (answer === null) throw unanswered(`updating ${name}`);
    if (!answer) {
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
    // The lock moves before the new version counts as installed. When either fails, the old
    // version stays, with the lock as it was.
    try {
      buildAndSetUp(manifest, newFolder, true, remote);
      if (pin) writeBoth(() => setLocked(db, source, lockedAs(manifest, cloned.commit)));
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

// Updates the named plugin, or every one of yours, for sc update -g. A plugin your files name
// that isn't installed here is installed at its newest version instead, after asking, so its lock
// moves too. `name` is a plugin's name or its owner/repo. A plugin only a repository's files name
// isn't yours, so it is left at the version that repository's skelcrew.lock pins.
export function updatePlugins(name?: string): void {
  const db = openDb();
  const lock = yourLock(db);
  const named = yourPlugins();
  // A plugin from a folder is yours, as no repository can name one.
  const installed = installedPlugins(db).filter(
    (plugin) => plugin.source === null || named.includes(plugin.source),
  );
  const missing = named.filter((source) => !installed.some((plugin) => plugin.source === source));
  const chosen = installed.filter(
    (plugin) => name === undefined || plugin.name === name || plugin.source === name,
  );
  const toInstall = missing.filter(
    (source) => name === undefined || source === name || lock[source]?.name === name,
  );
  if (name !== undefined && chosen.length + toInstall.length === 0)
    throw new Error(`there is no plugin named ${name}: sc plugins lists them`);
  if (chosen.length + toInstall.length === 0) console.log("No plugins installed.");
  const plugins = [...chosen, ...toInstall];
  eachAsked(
    plugins,
    (plugin) => (typeof plugin === "string" ? plugin : plugin.name),
    (plugin) => (typeof plugin === "string" ? installPlugin(plugin) : updatePlugin(db, plugin)),
  );
}

// Removes a plugin with its settings and tokens. A plugin from GitHub loses its folders and its
// line in your lock too, and with `named` its line under plugins: in your config.yaml. A folder of
// yours stays. It refuses while the plugin is the tracker of a repository Skelcrew has, as that
// repository would lose its tasks, and while it is the forge of one, which would lose its PRs and
// its login for pushing.
export function removePlugin(name: string, named = false): void {
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
  // Your files change first. A write that fails puts both back and removes nothing, so the
  // plugin stays installed and named, and a retry starts over.
  const { source } = plugin;
  if (source !== null)
    writeBoth(() => {
      if (named) setYourPlugins(yourPlugins().filter((one) => one !== source));
      setLocked(db, source, null);
    });
  db.run("DELETE FROM plugins WHERE name = ?", [name]);
  // The settings folder is the one settingsDir makes.
  rmSync(join(configDir(), "plugins", name), { recursive: true, force: true });
  if (plugin.source !== null) rmSync(join(pluginsDir(), name), { recursive: true, force: true });
  console.log(`Removed ${name}, with its settings and tokens.`);
}

// Adds a personal plugin, for sc add -g: installs it after asking, then names it under plugins:
// in your config.yaml, beside the version your lock now pins. A folder of yours is installed on
// this machine only: its path means nothing on another machine, and it has no version to pin, so
// it stays out of your files and says so. A plugin a repository had installed here becomes yours at
// the version installed, asking nothing, as you approved that exact version before. Returns
// whether it was installed.
export function addPlugin(given: string, remote = originHere()): boolean {
  const db = openDb();
  const here = installedPlugins(db).find((plugin) => plugin.source === given);
  if (here && !yourPlugins().includes(given)) {
    const manifest = readManifest(here.folder);
    writeBoth(() => {
      setYourPlugins([...yourPlugins(), given]);
      setLocked(db, given, lockedAs(manifest, commitOf(here.folder)));
    });
    console.log(
      `Added ${manifest.name} ${manifest.version} to your plugins, at the version installed here.`,
    );
    return true;
  }
  if (!installPlugin(given, { remote, name: true })) return false;
  if (given.startsWith(".") || given.startsWith("/"))
    console.log(
      "A plugin from a folder is on this machine only, so your config.yaml and lock leave it out.",
    );
  return true;
}

// Removes a personal plugin, for sc remove -g: from plugins: in your config.yaml, from your lock
// and from this machine, with its settings and tokens. `given` is its name or its owner/repo. A
// plugin a repository still needs, as `needs` from repositoryNeeds says, leaves your files only,
// and stays installed with its settings and tokens, such as its login. It refuses while the plugin
// is the tracker or forge of a repository Skelcrew has, and for a plugin only a repository names,
// and then changes nothing.
export function removeYourPlugin(given: string, needs: Need[]): void {
  const db = openDb();
  const lock = yourLock(db);
  const named = yourPlugins();
  const plugin = installedPlugins(db).find((one) => one.name === given || one.source === given);
  // A plugin only a repository names isn't yours, so its settings and tokens stay.
  const yours = plugin && (plugin.source === null || named.includes(plugin.source));
  if (plugin && !yours)
    throw new Error(
      `${given} isn't one of your plugins, as only a repository's skelcrew.yaml names it, so Skelcrew keeps it`,
    );
  const installed = yours ? plugin : undefined;
  // A plugin your files name may not be installed here yet, so the lock names it too.
  const source =
    installed?.source ??
    yourPlugins().find((one) => one === given || lock[one]?.name === given) ??
    null;
  if (!installed && source === null)
    throw new Error(`there is no plugin named ${given}: sc plugins lists them`);
  const needed = needs.find((need) => need.source === source);
  if (installed && !needed) {
    removePlugin(installed.name, true);
    return;
  }
  if (source === null) return;
  writeBoth(() => {
    setYourPlugins(yourPlugins().filter((one) => one !== source));
    setLocked(db, source, null);
  });
  console.log(
    installed && needed
      ? `Removed ${given} from your plugins. It stays installed, as ${needed.where}'s skelcrew.yaml names it.`
      : `Removed ${given} from your plugins.`,
  );
}

// Returns whether the plugin is installed at exactly the version and commit locked.
export function matchesLock(plugin: Plugin, locked: Locked): boolean {
  return (
    readManifest(plugin.folder).version === locked.version &&
    commitOf(plugin.folder) === locked.commit
  );
}

// Makes this machine match your personal files, for sc install: installs each plugin under
// plugins: in your config.yaml at the version and commit your lock pins. A plugin new here, or at
// another version or commit, is shown and asked about. One already at its locked version asks
// nothing, as you approved it before. It never moves a pin your lock has. A plugin your config
// names that the lock lacks gets a pin added, as npm install does: at what is installed here, or
// else at its newest version tag once you say yes. Returns whether there was anything to do, and
// the plugins still missing or at another version than locked, as you said no to them.
// `remote` is handed to each setup. `conflicting` are the plugins a repository pins at another
// commit than your lock: each is left as it is, neither installed nor moved, and the repository's
// install says why. One of them that isn't here at your pin is among those still missing.
export function installYourPlugins(
  remote: string | null,
  conflicting: string[] = [],
): { changed: boolean; left: string[] } {
  const db = openDb();
  const lock = yourLock(db);
  let changed = false;
  const mine = yourPlugins().filter((source) => !conflicting.includes(source));
  eachAsked(
    mine,
    (source) => source,
    (source) => {
      const locked = lock[source];
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      // A plugin installed before your lock named it is pinned as it is, with nothing to ask.
      if (here && !locked) {
        setLocked(db, source, lockedAs(readManifest(here.folder), commitOf(here.folder)));
        return;
      }
      if (here && locked && matchesLock(here, locked)) return;
      changed = true;
      // Installing with no pin adds one. One with a pin leaves the lock as it is.
      if (!locked) installPlugin(source, { remote });
      else {
        const pinned = { tag: `v${locked.version}`, commit: locked.commit, remote, pin: false };
        if (here) updatePlugin(db, here, pinned);
        else installPlugin(source, pinned);
      }
    },
  );
  // Read again, as an install added its pin.
  const now = yourLock(db);
  // One left as it is for a repository's pin still counts when it isn't here at yours, so the
  // machine isn't set up while it is missing.
  const left = yourPlugins().filter((source) => {
    const here = installedPlugins(db).find((plugin) => plugin.source === source);
    const locked = now[source];
    return !here || (locked !== undefined && !matchesLock(here, locked));
  });
  return { changed, left };
}

// One row of sc plugins: a plugin your files name or this machine has. The version, kind and
// what it provides are the installed one's, or with none installed, the version locked. `from`
// is where it comes from, and `change` what sc install would do to it, or null for nothing.
type Row = {
  name: string;
  version: string | null;
  kind: string | null;
  provides: string[];
  jobs: string[];
  from: string;
  change: string | null;
};

// Prints the plugins your files and repositories' files name and this machine has, for sc
// plugins: each one's name, version, kind and what it provides, such as "github 0.1.0 io:
// tracker, forge", and what sc install would change. `needs` are the plugins repositories need,
// as repositoryNeeds gives them. --json gives the same rows for tools, and keeps jobs, so a tool
// written before kinds still reads it.
export function listPlugins(json: boolean, needs: Need[]): void {
  const db = openDb();
  const lock = yourLock(db);
  const wanted = yourPlugins();
  const installed = installedPlugins(db);
  // What sc install would do for a repository's plugin, or null for nothing. The first need
  // that changes something is said, as sc install acts on it first.
  const repositoryChange = (source: string, plugin?: Plugin): string | null => {
    for (const { where, locked, conflict } of needs.filter((need) => need.source === source)) {
      if (conflict !== null) return `sc install leaves it, as it is pinned at ${conflict}`;
      if (!locked) return `${where}'s skelcrew.lock doesn't pin it, so sc install leaves it out`;
      if (!plugin) return `sc install installs ${locked.version} for ${where}`;
      if (!matchesLock(plugin, locked))
        return `sc install moves it to ${locked.version} at commit ${locked.commit.slice(0, 12)} for ${where}`;
    }
    return null;
  };
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
      // What it provides, under the name tools read before plugins had kinds.
      jobs: manifest.provides,
      from: plugin.source ?? plugin.folder,
      change: moves
        ? `sc install moves it to ${to}`
        : plugin.source === null
          ? null
          : repositoryChange(plugin.source, plugin),
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
      jobs: [],
      from: source,
      change: locked ? "sc install installs it" : "sc install installs its newest version",
    });
  }
  // Then those only repositories name that aren't installed here, once each.
  for (const { source, locked } of needs) {
    if (rows.some((row) => row.from === source)) continue;
    rows.push({
      name: locked?.name ?? source,
      version: locked?.version ?? null,
      kind: null,
      provides: [],
      jobs: [],
      from: source,
      change: repositoryChange(source),
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
