// The plugins built into skel, each connecting it to one outside tool, and turning them on and
// off. The flow reaches a plugin only through the job it does, never by its name.
import { existsSync, rmSync } from "node:fs";
import { pluginSettings, savePluginSettings } from "./config.ts";
import { pluginTokenFile } from "./paths.ts";
import { slack } from "./plugins/slack.ts";

// A message that came in through chat: who sent it, in words, the address skel reply sends an
// answer to, and what it said.
export type Message = { from: string; to: string; text: string };

// Chat: carries notes and messages between you and the lead. `tell` hears each note skel types
// into the lead. `hear` returns the messages since the points in `seen`, with the points to
// save, so a daemon that was down loses nothing. `reply` sends the lead's answer.
export type Chat = {
  tell: (text: string) => Promise<void>;
  hear: (
    seen: Record<string, string>,
  ) => Promise<{ messages: Message[]; seen: Record<string, string> }>;
  reply: (to: string, text: string) => Promise<void>;
};

// A plugin: its name, what it is for in a few words, `add`, which turns it on in your terminal
// and returns what to print, and the jobs it does.
export type Plugin = { name: string; about: string; add: () => Promise<string>; chat?: Chat };

export const plugins: Plugin[] = [slack];

// Returns the plugin by its name, or throws naming the ones there are.
export function pluginNamed(name: string): Plugin {
  const found = plugins.find((p) => p.name === name);
  if (found) return found;
  const names = plugins.map((p) => p.name).join(", ");
  throw new Error(`skel has no plugin called ${name}. It has ${names}`);
}

// Returns whether a plugin is on: it is once its settings are in config.yaml.
export const isOn = (plugin: Plugin) => pluginSettings(plugin.name) !== undefined;

// Returns the chat plugins that are on, with their names, for the flow to tell and hear.
export const chats = () =>
  plugins.flatMap((p) => (p.chat && isOn(p) ? [{ name: p.name, ...p.chat }] : []));

// Turns a plugin off for skel plugin rm: removes its token and its settings, so nothing of it
// is left to read. Returns whether it was on.
export function turnOff(plugin: Plugin): boolean {
  const was = isOn(plugin) || existsSync(pluginTokenFile(plugin.name));
  rmSync(pluginTokenFile(plugin.name), { force: true });
  savePluginSettings(plugin.name, undefined);
  return was;
}
