// Your setup, copied from the laptop to a server or Sprite by sc remote add and sc --remote:
// your config.yaml, the agents' Claude Code token, and your plugins at the laptop's versions.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { openDb } from "../db.ts";
import { claudeTokenFile, configDir, dataDir } from "../paths.ts";
import { installedPlugins, readManifest } from "../plugins/plugin.ts";
import { errorText } from "../say.ts";

// Your setup as it is copied: config.yaml as written, the agents' token or null, and each
// plugin installed from a version tag. No plugin's own files are in it: a plugin keeps a
// sign-in that renews itself among them, and two machines sharing one would cancel each other's.
const Setup = z.object({
  config: z.string(),
  token: z.string().nullable(),
  plugins: z.array(z.object({ name: z.string(), source: z.string(), version: z.string() })),
});
export type Setup = z.infer<typeof Setup>;

// What the laptop sends: its setup, and the remote of the checkout you ran sc in, which a
// plugin's setup is handed as on the laptop.
const Sent = Setup.extend({ remote: z.string().nullable() });

// Returns the path of config.yaml. config.ts has it too, but brings in the harnesses, which sc
// --remote on the laptop has no need to load.
const configFile = () => join(configDir(), "config.yaml");

// Where the laptop puts the setup it sends, until the machine takes it.
const sentFile = () => join(configDir(), "laptop-setup.json");

// Returns the setup on this machine, or null when there is none yet: without config.yaml the
// first run never ran here. A plugin from a folder of yours has no version to match, and a
// machine plugin belongs on the laptop, so neither is part of it.
export function setupHere(): Setup | null {
  if (!existsSync(configFile())) return null;
  const token = existsSync(claudeTokenFile()) ? readFileSync(claudeTokenFile(), "utf8") : null;
  // Opening the database would make one, so a machine without one has no plugins.
  const db = existsSync(join(dataDir(), "skelcrew.db")) ? openDb() : null;
  const plugins = (db ? installedPlugins(db) : []).flatMap(({ name, folder, source }) => {
    if (source === null) return [];
    const { jobs, version } = readManifest(folder);
    return jobs.includes("machine") ? [] : [{ name, source, version }];
  });
  return { config: readFileSync(configFile(), "utf8"), token, plugins };
}

// Returns a short fingerprint of a setup. The laptop passes its own with each command, so the
// machine can tell when its setup differs at no cost of a round trip.
export const setupHash = (setup: Setup) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(setup)).digest("hex").slice(0, 16);

// Reports whether this machine's setup differs from the laptop's that runs this command with
// --remote. A change made here counts too, so the laptop's setup replaces it.
export function setupDiffers(): boolean {
  const laptop = process.env.SKELCREW_LAPTOP_SETUP;
  if (!laptop) return false;
  const here = setupHere();
  return here === null || setupHash(here) !== laptop;
}

// Writes the bundle the laptop sends to a file readable only by you, as it holds the token.
export function writeSent(file: string, setup: Setup, remote: string | null): void {
  writeFileSync(file, JSON.stringify({ ...setup, remote }), { mode: 0o600 });
}

// Takes the setup the laptop sent, for sc take-setup on a server or Sprite. config.yaml and the
// token become the laptop's. Each plugin is installed, or moved, to the laptop's version without
// asking, as you trusted it there, and its setup runs here in your terminal so it signs in on its
// own. A plugin gone from the laptop goes here too, and one from a folder here stays.
export async function takeSetup(): Promise<void> {
  const file = sentFile();
  let sent: z.infer<typeof Sent>;
  try {
    sent = Sent.parse(JSON.parse(readFileSync(file, "utf8")));
  } finally {
    rmSync(file, { force: true });
  }
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), sent.config);
  // Removed first, as a mode is only given to a file as it is made.
  rmSync(claudeTokenFile(), { force: true });
  if (sent.token !== null) writeFileSync(claudeTokenFile(), sent.token, { mode: 0o600 });
  // Loaded only here, as it brings in much of Skelcrew that the check on each command needs none of.
  const { installPlugin, removePlugin, updatePlugin } = await import("../plugins/install.ts");
  const db = openDb();
  const wanted = new Map(sent.plugins.map((plugin) => [plugin.name, plugin]));
  for (const plugin of installedPlugins(db)) {
    const keep = wanted.get(plugin.name);
    if (plugin.source === null || readManifest(plugin.folder).jobs.includes("machine")) continue;
    if (keep?.source === plugin.source) continue;
    // A plugin that is a repository's tracker or forge here refuses to go, which is only said:
    // the command you ran still runs.
    try {
      removePlugin(plugin.name);
    } catch (error) {
      console.log(`Couldn't remove ${plugin.name}, as on your laptop: ${errorText(error)}`);
    }
  }
  for (const { name, source, version } of sent.plugins) {
    const here = installedPlugins(db).find((plugin) => plugin.name === name);
    if (!here) installPlugin(source, sent.remote, false, `v${version}`);
    else if (here.source === null)
      throw new Error(
        `${name} here is installed from a folder, so the one on your laptop can't be: sc plugin rm ${name} here first`,
      );
    else if (readManifest(here.folder).version !== version)
      updatePlugin(db, here, `v${version}`, sent.remote);
  }
}
