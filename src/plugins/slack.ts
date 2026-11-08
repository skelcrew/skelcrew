// The Slack plugin, as chat: notes for the lead go to a channel, and direct messages from
// the people you list reach the lead, whose answers go back. Every call goes to Slack's Web
// API, from the daemon, with a token no agent can read.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { pluginSettings, savePluginSettings } from "../config.ts";
import { promptSecret } from "../machine/secret.ts";
import { pluginTokenFile } from "../paths.ts";
import { skelLine } from "../say.ts";

// Tests point this at a fake Slack.
const apiUrl = () => process.env.SKEL_SLACK_URL || "https://slack.com/api";

// Slack's IDs for channels, people and direct messages: capital letters and digits. Anything
// else, such as #general or a name, is refused, as Slack's API takes only IDs.
const Id = z.string().regex(/^[A-Z0-9]+$/);
const Settings = z.object({
  channel: Id,
  people: z.array(Id).min(1),
});
type Settings = z.infer<typeof Settings>;

// Slack's message times, such as 1731000000.123456, also serve as their IDs.
const Ts = z.string().regex(/^\d+\.\d+$/);

const Answer = z.looseObject({ ok: z.boolean(), error: z.string().optional() });

// Calls a method of Slack's Web API with the token, and returns its answer checked. Slack
// answers 200 even when it refuses, and says why in `error`, which goes in the error thrown,
// such as invalid_auth for a wrong token. A form body works for every method skel uses.
async function call(token: string, method: string, args: Record<string, string>) {
  const response = await fetch(`${apiUrl()}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(args),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Slack answered ${method} with HTTP ${response.status}`);
  const answer: unknown = await response.json();
  const said = Answer.parse(answer);
  if (!said.ok) throw new Error(`Slack refused ${method}: ${said.error ?? "it gave no reason"}`);
  return answer;
}

// Returns the token and settings, for each use, so a change made with skel plugin reaches the
// daemon with no restart. Throws when either is missing or broken, naming the fix.
function readSlack(): Settings & { token: string } {
  const read = Settings.safeParse(pluginSettings("slack"));
  if (!read.success)
    throw new Error(`Slack's settings aren't valid: run skel plugin add slack again`);
  let token: string;
  try {
    token = readFileSync(pluginTokenFile("slack"), "utf8").trim();
  } catch {
    throw new Error("Slack's token is missing: run skel plugin add slack again");
  }
  return { ...read.data, token };
}

// Direct message channels by person. A person's never changes, so it is asked for once per
// daemon.
const directs = new Map<string, string>();

// Returns the channel of skel's direct messages with a person, opening it the first time.
async function directTo(token: string, person: string): Promise<string> {
  const known = directs.get(person);
  if (known) return known;
  const opened = await call(token, "conversations.open", { users: person });
  const { id } = z.object({ channel: z.object({ id: Id }) }).parse(opened).channel;
  directs.set(person, id);
  return id;
}

const Said = z.looseObject({
  ts: Ts,
  text: z.string().catch(""),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
});

// Returns the messages in a channel after the given time, newest first, as Slack lists them.
async function messagesAfter(token: string, channel: string, after: string, limit: number) {
  const listed = await call(token, "conversations.history", {
    channel,
    oldest: after,
    limit: String(limit),
  });
  return z.object({ messages: z.array(Said) }).parse(listed).messages;
}

// Returns whether one Slack time comes after another. Compared as whole numbers, since the
// microseconds would be lost in a float.
const later = (a: string, b: string) => {
  const whole = (ts: string) => {
    const [seconds = "0", micro = ""] = ts.split(".");
    return BigInt(seconds) * 1_000_000n + BigInt(micro.padEnd(6, "0").slice(0, 6) || "0");
  };
  return whole(a) > whole(b);
};

// Slack escapes these three in message text.
const unescaped = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// Posts a note for the lead in the channel you named, so a team hears what needs you.
async function tell(text: string): Promise<void> {
  const { token, channel } = readSlack();
  await call(token, "chat.postMessage", { channel, text });
}

// Returns what each person on your list said in their direct messages with skel since the
// time `seen` holds for them, oldest first, and the new times to save. Only their own messages
// count, never skel's answers in the same conversation. A person skel hasn't looked at yet
// starts from their newest message, so what they said before Slack was turned on never
// reaches the lead.
async function hear(seen: Record<string, string>) {
  const { token, people } = readSlack();
  const messages: { from: string; to: string; text: string }[] = [];
  const now: Record<string, string> = {};
  for (const person of people) {
    const channel = await directTo(token, person);
    const after = seen[person];
    if (after === undefined) {
      const [newest] = await messagesAfter(token, channel, "0", 1);
      now[person] = newest?.ts ?? "0";
      continue;
    }
    // A hundred is the most Slack sends at once, and more than anyone types in a minute.
    const listed = await messagesAfter(token, channel, after, 100);
    const theirs = listed
      .filter((m) => later(m.ts, after) && m.user === person && !m.bot_id && !m.subtype)
      .reverse();
    for (const m of theirs)
      messages.push({ from: `${person} on Slack`, to: person, text: unescaped(m.text) });
    now[person] = listed.reduce((last, m) => (later(m.ts, last) ? m.ts : last), after);
  }
  return { messages, seen: now };
}

// Posts the lead's answer in skel's direct messages with the person. Only to people on your
// list, since an instruction slipped to the lead could name anyone in the workspace.
async function reply(to: string, text: string): Promise<void> {
  const { token, people } = readSlack();
  if (!people.includes(to)) throw new Error(`${to} isn't on your list of people in Slack`);
  await call(token, "chat.postMessage", { channel: await directTo(token, to), text });
}

// Turns Slack on for skel plugin add, in your own terminal: asks for the bot token without
// showing it, checks it with Slack, asks for the channel and the people, and saves them.
// Nothing is saved unless all of it is right, so a mistake leaves Slack as it was. Returns
// what to print once it is on.
async function add(): Promise<string> {
  console.log(
    skelLine(
      "Slack will get every note skel types into the lead, and direct messages to skel's Slack app from the people you list will reach the lead.",
    ),
  );
  const token = promptSecret(skelLine("paste the bot token of skel's Slack app (xoxb-…):"))?.trim();
  if (!token) throw new Error("no token was pasted, so Slack stays off");
  const checked = await call(token, "auth.test", {});
  const { team } = z.object({ team: z.string() }).parse(checked);
  const channel = prompt(skelLine("the channel ID for notes, such as C0123ABCD:"))?.trim() ?? "";
  const people = (
    prompt(skelLine("the member IDs who may message the lead, comma separated:")) ?? ""
  )
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!Id.safeParse(channel).success)
    throw new Error(`${channel} isn't a channel ID, such as C0123ABCD, so Slack stays off`);
  const read = Settings.safeParse({ channel, people });
  if (!read.success)
    throw new Error("people needs member IDs, such as U0123ABCD, so Slack stays off");
  mkdirSync(dirname(pluginTokenFile("slack")), { recursive: true, mode: 0o700 });
  rmSync(pluginTokenFile("slack"), { force: true });
  // Created readable only by you, so the token is never in a file others can read.
  writeFileSync(pluginTokenFile("slack"), `${token}\n`, { mode: 0o600, flag: "wx" });
  savePluginSettings("slack", read.data);
  return `Slack is on, in ${team}. Notes go to ${channel}, and ${people.join(", ")} can message the lead.`;
}

export const slack = {
  name: "slack",
  about: "notes in a Slack channel, and direct messages with the lead",
  add,
  chat: { tell, hear, reply },
};
