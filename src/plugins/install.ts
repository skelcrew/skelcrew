// Installs, updates, replaces and explicitly removes plugins in your terminal.
// Personal pins stay in your lock; replacement keeps settings and sign-ins.
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { hasTasks, openDb } from "../db.ts";
import { markMissingPlugin } from "../flow/missing-plugins.ts";
import { repositories } from "../flow/repo.ts";
import { liveThreads, taskName } from "../flow/thread.ts";
import { originHere } from "../machine/origin.ts";
import { configDir, dataDir } from "../paths.ts";
import { removeControlCodes } from "../screen/look.ts";
import { readSettings } from "../settings.ts";
import { release } from "../version.ts";
import { trackerOf } from "./ask.ts";
import { type Locked, setLocked, writeBoth, yourLock, yourPlugins } from "./lock.ts";
import {
  commandFor,
  commitOf,
  findPlugin,
  installedPlugins,
  type Manifest,
  type Plugin,
  reachesOnlyMachines,
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

// Returns why git couldn't read a plugin's repository on GitHub, from what git said. GitHub
// answers a private or missing repository alike, so both read as one, with what to do.
function unreadable(source: string, said: string): Error {
  if (/could not read Username|Repository not found/.test(said))
    return new Error(
      `Skelcrew couldn't read ${source} on GitHub: it isn't public, or doesn't exist. Make it public, or sign git in to GitHub on this machine, then run this again`,
    );
  return new Error(`git couldn't reach ${source} on GitHub: ${said}`);
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
  if (!listed.success) throw unreadable(source, listed.stderr.toString().trim());
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

function cloneTag(
  source: string,
  tag: string,
  commit?: string,
  staged = join(pluginsDir(), `.cloning-${process.pid}`),
): { staged: string; manifest: Manifest; commit: string } {
  mkdirSync(dirname(staged), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  const url = `https://github.com/${source}`;
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-c", "advice.detachedHead=false", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  if (commit === undefined) {
    const cloned = git(["clone", "--quiet", "--depth", "1", "--branch", tag, url, staged]);
    if (!cloned.success) {
      const said = cloned.stderr.toString().trim();
      if (/could not read Username|Repository not found/.test(said)) throw unreadable(source, said);
      throw new Error(`git couldn't clone ${source} at ${tag}: ${said}`);
    }
  } else {
    const said = (run: { stderr: Buffer }) => run.stderr.toString().trim();
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
      rmSync(staged, { recursive: true, force: true });
      const cloned = git(["clone", "--quiet", "--depth", "1", "--branch", tag, url, staged]);
      if (!cloned.success) {
        rmSync(staged, { recursive: true, force: true });
        throw new Error(
          `git couldn't reach commit ${commit.slice(0, 12)} of ${source}, which your lock pins: ${said(fetched)}. Nor its tag ${tag}: ${said(cloned)}`,
        );
      }
      const at = commitOf(staged);
      if (at !== commit) {
        rmSync(staged, { recursive: true, force: true });
        throw new Error(
          `${source} no longer serves commit ${commit.slice(0, 12)}, which your lock pins: git couldn't fetch it (${said(fetched)}), and its tag ${tag} is at ${at.slice(0, 12)} now. sc plugin update -g moves it to its newest version, after showing what it runs`,
        );
      }
    }
  }
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

// Returns whether an answer to a [Y/n] question is yes: Enter, y or yes, in any case.
const isYes = (line: string) => ["", "y", "yes"].includes(line.trim().toLowerCase());

// Asks a question at your terminal and returns the line typed, or null with no terminal or after
// Ctrl-D. Only a terminal counts, so an answer piped in from a script or the daemon never installs
// a plugin. Bun's own prompt gives null both for a bare Enter and for the end of the input, which
// would take silence for a yes. The answer is read a byte at a time, so a question after this one
// still finds its own line.
function askLine(question: string): string | null {
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
  return line;
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

// Shows what the plugin is and asks whether to `verb` it, such as Install. First comes what it is
// for, in plain words: the plugin's own one-line description. Then its name, version
// and source, and that it runs as you, outside the sandbox. d shows the rest, its kind, what it
// provides and every command its manifest runs, and asks again. An answer is a line, as for every
// question here, so the Enter after a key never answers the next question. Returns true for yes,
// false for any other answer, and null with no terminal to answer in. Nothing of the plugin runs
// before this.
function confirmPlugin(manifest: Manifest, from: string, verb: string): boolean | null {
  const { name, version, kind, provides, about } = manifest;
  const source = removeControlCodes(from);
  console.log(removeControlCodes(about));
  console.log(
    `\n${name} plugin ${version}, from ${source}. Runs on this machine as you, outside the agents' sandbox. Type d for details.`,
  );
  while (true) {
    const answer = askLine(`${verb} the ${name} plugin? [Y/n]`);
    if (answer === null) return null;
    if (answer.trim().toLowerCase() !== "d") return isYes(answer);
    const kindName = kind === "io" ? "an I/O" : "a runtime";
    const commands = commandsOf(manifest).map(
      (words) => `  ${removeControlCodes(words.map(shellWord).join(" "))}`,
    );
    console.log(
      `\n${name} ${version} from ${source} is ${kindName} plugin that provides ${provides.join(", ")}. It runs these as you, outside Skelcrew's sandbox:\n${commands.join("\n")}\n`,
    );
  }
}

// The error for a plugin's commands that would run with no terminal to answer whether they may. It
// fails the command, so a script that runs sc install can tell the machine doesn't match your files
// yet. A class of its own lets sc install and sc plugin update -g go on to the other plugins and
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
// would do it too, but would fetch and build the plugin again for nothing. sc plugin
// setup runs it for the checkout you are in, and plain sc for a repository whose forge needs it.
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

function refuseInstalled(db: Database, name: string, io: boolean | undefined): void {
  const here = installedPlugins(db).find((plugin) => plugin.name === name);
  if (!here) return;
  if (!io) throw new Error(`${name} is installed already: run sc plugin update -g ${name}`);
  if (here.source === null)
    throw new Error(
      `${name} is installed here from the folder ${here.folder}, which has no version a repository could pin`,
    );
  throw new Error(
    `${name} is installed here from ${here.source}, another plugin with the same name, and one name can't be two plugins`,
  );
}

type Options = {
  source?: string;
  remote?: string | null;
  ask?: boolean;
  tag?: string;
  commit?: string;
  pin?: boolean;
  io?: boolean;
  orYours?: boolean;
  onlyYours?: string;
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

// Returns what makes a plugin yours only, such as "a runtime plugin", or null when a repository
// can name it.
export function personalKind(manifest: Manifest): string | null {
  if (manifest.kind === "runtime") return "a runtime plugin";
  if (manifest.provides.includes("notifier")) return "a notifier, which reaches you";
  return null;
}

export function refusePersonal(manifest: Manifest, io: boolean | undefined): void {
  const kind = personalKind(manifest);
  if (io && kind)
    throw new Error(
      `${manifest.name} is ${kind}, so it is always yours and never a repository's. sc plugin add -g adds it as yours`,
    );
}

// Installs a plugin and returns whether it did. `given` is either owner/repo, installed from that
// GitHub repository's newest version tag or the one `tag` names, or a path to a folder of yours,
// used where it is. It shows what the plugin runs and asks first, unless `ask` is false, as for
// sc install, where running it is your yes: then it says in a line what it installs. Either way
// it installs only at a terminal. Then it runs the plugin's build
// and setup, and writes your lock when `pin` says to, before the plugin counts as
// installed. A write that fails leaves the files as they were and the plugin not installed.
export function installPlugin(given: string, options: Options = {}): boolean {
  const { ask = true, tag, commit, called } = options;
  let { pin = true, io = false } = options;
  const remote = options.remote === undefined ? originHere() : options.remote;
  const db = openDb();
  const isPath = given.startsWith(".") || given.startsWith("/");
  if (isPath) {
    const folder = realpathSync(resolve(given));
    const manifest = readManifest(folder);
    refuseInstalled(db, manifest.name, io);
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
  if (!/^[\w.][\w.-]*\/[\w.-]+$/.test(given))
    throw new Error(`${given} is neither a folder, such as ./skelcrew-linear, nor owner/repo`);
  const cloned = cloneTag(given, tag ?? newestTag(given), commit);
  const { staged, manifest } = cloned;
  try {
    const kind = personalKind(manifest);
    if (io && options.orYours && kind) {
      io = false;
      pin = true;
    }
    if (io && options.onlyYours !== undefined && !kind) throw new Error(options.onlyYours);
    const here = installedPlugins(db).find((plugin) => plugin.name === manifest.name);
    if (here?.source && here.source !== given && process.stdin.isTTY) {
      checkSkelcrewVersion(manifest);
      refusePersonal(manifest, io);
      refuseOtherName(manifest, called);
      const answer = askLine(`Replace ${manifest.name} from ${here.source} with ${given}? [y/N]`);
      if (answer === null) throw unanswered(`replacing ${manifest.name}`);
      if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
        console.log(`Skelcrew didn't replace ${manifest.name}.`);
        return false;
      }
      updatePlugin(db, here, {
        ...options,
        io,
        pin,
        source: given,
        tag: `v${manifest.version}`,
        commit: cloned.commit,
      });
      return installedPlugins(db).some(
        (plugin) => plugin.name === manifest.name && plugin.source === given,
      );
    }
    refuseInstalled(db, manifest.name, io);
    checkSkelcrewVersion(manifest);
    refusePersonal(manifest, io);
    refuseOtherName(manifest, called);
    const answer = ask ? confirmPlugin(manifest, given, "Install") : process.stdin.isTTY || null;
    if (answer === null) throw unanswered(`installing ${manifest.name}`);
    if (!answer) {
      console.log(`Skelcrew didn't install ${manifest.name}.`);
      return false;
    }
    if (!ask)
      console.log(
        `Installing ${manifest.name} ${manifest.version} from ${given} (runs as you, outside the agents' sandbox).`,
      );
    const folder = join(pluginsDir(), manifest.name, manifest.version);
    rmSync(dirname(folder), { recursive: true, force: true });
    mkdirSync(dirname(folder), { recursive: true });
    renameSync(staged, folder);
    try {
      buildAndSetUp(manifest, folder, true, remote);
      writeBoth(() => {
        if (pin) setLocked(given, lockedAs(manifest, cloned.commit));
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
    db.run("DELETE FROM removed_plugins WHERE source = ?", [given]);
    markUnclaimed(db, manifest);
    console.log(`Installed ${manifest.name} ${manifest.version}.`);
    return true;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

// Returns how the lock pins a plugin at this manifest's version and this commit.
export const lockedAs = (manifest: Manifest, commit: string): Locked => ({
  name: manifest.name,
  version: manifest.version,
  commit,
});

// Returns how a lock would pin a plugin from GitHub at its newest version, reading its manifest from
// a clone in a temporary folder that is then removed, so nothing of the plugin is installed or run,
// and nothing is left on the machine.
export function newestLocked(source: string): Locked {
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-plugin-"));
  try {
    const { manifest, commit } = cloneTag(
      source,
      newestTag(source),
      undefined,
      join(folder, "clone"),
    );
    return lockedAs(manifest, commit);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Updates one plugin. One from a folder is built again from it, so your edits count. One from
// GitHub moves to its newest version tag, or to the one `tag` names at the lock's `commit`, after
// showing what it runs and asking, as installing does, or with `ask` false, as for sc install,
// saying so in a line, only at a terminal. Its old version's folder goes, and your
// lock pins the new one, unless `pin` is false.
export function updatePlugin(db: Database, plugin: Plugin, options: Options = {}): void {
  const { ask = true, tag: wanted, commit, pin = true, io, called } = options;
  const remote = options.remote === undefined ? originHere() : options.remote;
  const { name, folder } = plugin;
  const source = options.source ?? plugin.source;
  const current = readManifest(folder);
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
  const atNewest = () => {
    setLocked(source, lockedAs(current, commitOf(folder)));
    console.log(`${name} is at its newest version, ${current.version}.`);
  };
  const cloned = cloneTag(source, tag, commit);
  const { staged, manifest } = cloned;
  try {
    if (!wanted && manifest.version === current.version && cloned.commit === commitOf(folder)) {
      atNewest();
      return;
    }
    if (manifest.name !== name)
      throw new Error(`${source} now names its plugin ${manifest.name}, not ${name}`);
    checkSkelcrewVersion(manifest);
    refusePersonal(manifest, io);
    refuseOtherName(manifest, called);
    const answer = ask ? confirmPlugin(manifest, source, "Update") : process.stdin.isTTY || null;
    if (answer === null) throw unanswered(`updating ${name}`);
    if (!answer) {
      console.log(`Skelcrew didn't update ${name}.`);
      return;
    }
    if (!ask)
      console.log(
        `Updating ${name} ${current.version} to ${manifest.version === current.version ? `its commit ${cloned.commit.slice(0, 12)}` : manifest.version} from ${source} (runs as you, outside the agents' sandbox).`,
      );
    const versionFolder = join(pluginsDir(), name, manifest.version);
    const newFolder =
      versionFolder === folder ? `${versionFolder}-${cloned.commit.slice(0, 12)}` : versionFolder;
    rmSync(newFolder, { recursive: true, force: true });
    renameSync(staged, newFolder);
    try {
      buildAndSetUp(manifest, newFolder, true, remote);
      writeBoth(() => {
        if (
          pin ||
          (source !== plugin.source && plugin.source !== null && yourLock()[plugin.source])
        )
          setLocked(source, lockedAs(manifest, cloned.commit));
        if (plugin.source !== null && source !== plugin.source && yourLock()[plugin.source])
          setLocked(plugin.source, null);
      });
    } catch (error) {
      rmSync(newFolder, { recursive: true, force: true });
      throw error;
    }
    db.run("UPDATE plugins SET folder = ?, source = ? WHERE name = ?", [newFolder, source, name]);
    db.run("DELETE FROM removed_plugins WHERE source = ?", [source]);
    if (source !== plugin.source) console.log(`${name} moved from ${plugin.source} to ${source}`);
    removePluginFolder(plugin);
    console.log(`Updated ${name} from ${current.version} to ${manifest.version}.`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export function updatePlugins(name?: string): void {
  const db = openDb();
  const lock = yourLock();
  const named = yourPlugins();
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
    throw new Error(`there is no plugin named ${name}: sc plugin ls lists them`);
  if (chosen.length + toInstall.length === 0) console.log("No plugins installed.");
  const plugins = [...chosen, ...toInstall];
  eachAsked(
    plugins,
    (plugin) => (typeof plugin === "string" ? plugin : plugin.name),
    (plugin) => (typeof plugin === "string" ? installPlugin(plugin) : updatePlugin(db, plugin)),
  );
}

type PluginUse = { job: "tracker" | "forge" | "session host"; names: string[] };

function usesOf(db: Database, name: string): PluginUse[] {
  const jobs: PluginUse[] = [];
  for (const [job, usingIt] of [
    ["tracker", repositories(db).filter((r) => trackerOf(db, r) === name)],
    ["forge", repositories(db).filter((r) => r.forge === name)],
  ] as const)
    if (usingIt.length > 0) jobs.push({ job, names: usingIt.map((r) => r.name) });
  const builders = z.array(z.object({ name: z.string(), task: z.coerce.string() })).parse(
    db
      .query(`SELECT repositories.name, threads.task FROM threads
      JOIN repositories ON repositories.owner = threads.owner AND repositories.repo = threads.repo
      WHERE threads.host = ? AND threads.status IN ('working', 'waiting') ORDER BY repositories.name, threads.task`)
      .all(name),
  );
  const leads = z
    .array(z.object({ name: z.string() }))
    .parse(
      db
        .query(
          "SELECT name FROM repositories WHERE lead_host = ? AND lead_session IS NOT NULL AND tab_closed = 0 ORDER BY name",
        )
        .all(name),
    );
  const sessions = [
    ...builders.map((thread) => taskName(thread.name, String(thread.task))),
    ...leads.map((lead) => `the lead of ${lead.name}`),
  ];
  if (sessions.length > 0) jobs.push({ job: "session host", names: sessions });
  return jobs;
}

function removePluginFolder(plugin: Plugin): void {
  if (plugin.source === null) return;
  rmSync(plugin.folder, { recursive: true, force: true });
  const parent = dirname(plugin.folder);
  if (existsSync(parent) && readdirSync(parent).length === 0)
    rmSync(parent, { recursive: true, force: true });
}

function removePlugin(name: string): void {
  const db = openDb();
  const plugin = findPlugin(db, name);
  const { source } = plugin;
  const forges = repositories(db).filter((r) => r.forge === name);
  const trackers = repositories(db).filter((r) => trackerOf(db, r) === name);
  if (source !== null) writeBoth(() => setLocked(source, null));
  const table = hasTasks(db) ? "tasks" : "threads";
  db.transaction(() => {
    if (source !== null)
      db.run("INSERT OR IGNORE INTO removed_plugins (source) VALUES (?)", [source]);
    db.run("DELETE FROM plugins WHERE name = ?", [name]);
    for (const repository of forges) {
      const key = [repository.owner, repository.repo];
      db.run(
        `UPDATE ${table} SET pr = NULL, pr_link = NULL, checks = NULL, ci_passed = 0, conflicts = NULL WHERE owner = ? AND repo = ? AND task IN (SELECT task FROM threads WHERE owner = ? AND repo = ? AND status != 'done')`,
        [...key, ...key],
      );
      db.run(
        "DELETE FROM items WHERE owner = ? AND repo = ? AND kind = 'pr' AND state = 'open'",
        key,
      );
      db.run("DELETE FROM pr_agents WHERE owner = ? AND repo = ?", key);
      db.run(
        "UPDATE repositories SET forge = NULL, author = NULL, open_prs = 0 WHERE owner = ? AND repo = ?",
        key,
      );
    }
    for (const repository of trackers) {
      const key = [repository.owner, repository.repo];
      db.run(
        `UPDATE ${table} SET issue = NULL, issue_ref = NULL, issue_link = NULL, closes = NULL, assigned = 0 WHERE owner = ? AND repo = ? AND task IN (SELECT task FROM threads WHERE owner = ? AND repo = ? AND status != 'done')`,
        [...key, ...key],
      );
      db.run(
        "DELETE FROM items WHERE owner = ? AND repo = ? AND kind = 'task' AND state = 'open'",
        key,
      );
      db.run("DELETE FROM claims WHERE owner = ? AND repo = ?", key);
      db.run("UPDATE repositories SET open_issues = 0 WHERE owner = ? AND repo = ?", key);
    }
  })();
  for (const thread of liveThreads(db)) markMissingPlugin(db, thread);
  rmSync(join(configDir(), "plugins", name), { recursive: true, force: true });
  removePluginFolder(plugin);
  console.log(`Removed ${name}, with its settings and tokens.`);
}

// Adds a personal plugin, for sc plugin add -g: installs it after asking and pins it in your lock. A folder of yours is
// installed on this machine only: its path means nothing on another machine, and it has no version
// to pin, so it stays out of your files and says so. A plugin a repository had installed here
// becomes yours at the version installed, asking nothing, as you approved that exact version
// before. Returns whether it was installed.
export function addPlugin(given: string, remote = originHere()): boolean {
  const db = openDb();
  const here = installedPlugins(db).find((plugin) => plugin.source === given);
  if (here && !yourPlugins().includes(given)) {
    const manifest = readManifest(here.folder);
    writeBoth(() => {
      setLocked(given, lockedAs(manifest, commitOf(here.folder)));
    });
    console.log(
      `Added ${manifest.name} ${manifest.version} to your plugins, at the version installed here.`,
    );
    return true;
  }
  if (!installPlugin(given, { remote })) return false;
  if (given.startsWith(".") || given.startsWith("/"))
    console.log("A plugin from a folder is on this machine only, so your lock leaves it out.");
  return true;
}

export function removeYourPlugin(given: string): void {
  const db = openDb();
  const lock = yourLock();
  const plugin = installedPlugins(db).find((one) => one.name === given || one.source === given);
  const source =
    plugin?.source ?? Object.keys(lock).find((one) => one === given || lock[one]?.name === given);
  if (!plugin && source === undefined)
    throw new Error(`there is no plugin named ${given}: sc plugin ls lists them`);
  const name = plugin?.name ?? (source ? lock[source]?.name : undefined) ?? given;
  const title = name === "github" ? "GitHub" : name;
  const answer = askLine(`Remove ${title}? [y/N]`);
  if (answer === null)
    throw new Error(
      `removing ${name} needs your yes at a terminal. Run sc plugin rm ${name} in your terminal`,
    );
  if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
    console.log(`Kept ${name}.`);
    return;
  }
  if (plugin) removePlugin(plugin.name);
  else if (source) {
    writeBoth(() => setLocked(source, null));
    console.log(`Removed ${name} from your plugins.`);
  }
}

// Returns whether the plugin is installed at exactly the version and commit locked.
export function matchesLock(plugin: Plugin, locked: Locked): boolean {
  return (
    readManifest(plugin.folder).version === locked.version &&
    commitOf(plugin.folder) === locked.commit
  );
}

// Returns installed GitHub plugins that neither personal nor repository locks name.
function unnamed(db: Database, needed: string[]): Plugin[] {
  const named = [...yourPlugins(), ...needed];
  return installedPlugins(db).filter((plugin) => {
    if (plugin.source === null || named.includes(plugin.source)) return false;
    try {
      return !reachesOnlyMachines(readManifest(plugin.folder));
    } catch {
      return false;
    }
  });
}

// Installs the personal plugins in your lock, leaving unnamed plugins installed.
// Conflicting pins stay as they are until they agree.
export function installYourPlugins(
  remote: string | null,
  conflicting: string[] = [],
): { changed: boolean; left: string[] } {
  const db = openDb();
  const lock = yourLock();
  let changed = false;
  const mine = Object.keys(lock).filter((source) => !conflicting.includes(source));
  eachAsked(
    mine,
    (source) => source,
    (source) => {
      const locked = lock[source];
      if (!locked) return;
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      if (here && matchesLock(here, locked)) return;
      changed = true;
      const pinned = { tag: `v${locked.version}`, commit: locked.commit, remote, pin: false };
      if (here) updatePlugin(db, here, { ...pinned, ask: false });
      else installPlugin(source, { ...pinned, ask: false });
    },
  );
  const left = Object.entries(lock)
    .filter(([source, locked]) => {
      const here = installedPlugins(db).find((plugin) => plugin.source === source);
      return conflicting.includes(source) || !here || !matchesLock(here, locked);
    })
    .map(([source]) => source);
  return { changed, left };
}

// One row of sc plugin ls: a plugin your files name or this machine has. The version, kind and
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
// as repositoryNeeds gives them, and `needed` the plugins any repository Skelcrew has names, or
// why that can't be told. --json gives the same rows for
// tools, and keeps jobs, so a tool written before kinds still reads it.
export function listPlugins(json: boolean, needs: Need[], needed: string[] | string): void {
  const db = openDb();
  const lock = yourLock();
  const wanted = [...new Set([...yourPlugins(), ...readSettings(["plugins"]).plugins])];
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
  // What sc install says of a plugin whose pins disagree, which it leaves as it is, or null.
  const disagreement = (source: string): string | null => {
    const conflict = needs.find((need) => need.source === source)?.conflict;
    return conflict ? `sc install leaves it, as it is pinned at ${conflict}` : null;
  };
  const unused = unnamed(db, typeof needed === "string" ? [] : needed).map((p) => p.name);
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
    const uses = unused.includes(plugin.name) ? usesOf(db, plugin.name) : [];
    return {
      name: plugin.name,
      version: manifest.version,
      kind: manifest.kind,
      provides: manifest.provides,
      // What it provides, under the name tools read before plugins had kinds.
      jobs: manifest.provides,
      from: plugin.source ?? plugin.folder,
      // A disagreement goes first, as sc install then leaves the plugin as it is.
      change: unused.includes(plugin.name)
        ? uses.length > 0
          ? `sc install keeps it, as it is ${uses.map(({ job, names }) => `the ${job} of ${names.join(", ")}`).join("; ")}`
          : "unused"
        : plugin.source === null
          ? null
          : (disagreement(plugin.source) ??
            (moves ? `sc install moves it to ${to}` : repositoryChange(plugin.source, plugin))),
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
      change:
        disagreement(source) ??
        (locked
          ? "sc install installs it"
          : `named in config.yaml but not installed; run sc plugin add -g ${source}`),
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
