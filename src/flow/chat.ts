// Chat with the lead through plugins, such as Slack: notes the lead hears go out, messages
// from people the plugin allows come in as notes, and the lead's answers go back.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { chats } from "../plugins.ts";
import { errorText } from "../say.ts";
import { tellLead } from "./lead.ts";

let telling: Promise<void> = Promise.resolve();

// Sends a note the lead just heard to every chat plugin that is on, so you hear it away from
// the terminal too. Returns at once, so a slow chat never holds up the lead's notes; notes
// still go out in order. One that fails is only logged: the lead has it.
export function tellChats(text: string): void {
  telling = telling.then(async () => {
    for (const chat of chats())
      await chat
        .tell(text)
        .catch((error) => console.log(`couldn't tell ${chat.name}: ${errorText(error)}`));
  });
}

const Seen = z
  .object({ place: z.string(), last: z.string() })
  .transform(({ place, last }): [string, string] => [place, last]);

// Asks each chat plugin that is on for new messages, saves each as a note for the lead, with
// the command that answers it, and saves how far it read, together, so a restart neither loses
// a message nor repeats one. Then has the lead hear them.
async function hearOnce(db: Database, tmux: string): Promise<void> {
  for (const chat of chats()) {
    const rows = db.query("SELECT place, last FROM heard WHERE plugin = ?").all(chat.name);
    const seen = Object.fromEntries(rows.map((row) => Seen.parse(row)));
    const heard = await chat.hear(seen);
    db.transaction(() => {
      for (const { from, to, text } of heard.messages) {
        // One line, as every note is, and outside text: its control codes go.
        const said = text
          .replace(/\s+/g, " ")
          .replace(/\p{Cc}/gu, " ")
          .trim()
          .slice(0, 2000);
        const answer = `To answer: skel reply ${chat.name}:${to} "<answer>"`;
        db.run("INSERT INTO notes (text, from_chat) VALUES (?, 1)", [
          `${from} says: ${said} ${answer}`,
        ]);
      }
      for (const [place, last] of Object.entries(heard.seen))
        db.run("INSERT OR REPLACE INTO heard (plugin, place, last) VALUES (?, ?, ?)", [
          chat.name,
          place,
          last,
        ]);
    })();
    if (heard.messages.length > 0) tellLead(db, tmux);
  }
}

// Checks every chat plugin that is on for messages every `every` milliseconds, in the
// background, starting at once. A check that fails, such as Slack being away, is logged and
// tried again at the next one. Checks never overlap, so a slow one can't hand the lead a
// message twice.
export function hearChats(db: Database, tmux: string, every: number): void {
  const check = () => {
    hearOnce(db, tmux)
      .catch((error) => console.log(`couldn't check chat: ${errorText(error)}`))
      .finally(() => setTimeout(check, every));
  };
  check();
}

// Sends the lead's answer for skel reply to the address a message's note named, such as
// slack:U0123ABCD, through the plugin before the colon.
export async function replyInChat(to: string, text: string): Promise<void> {
  const split = to.indexOf(":");
  const name = to.slice(0, Math.max(split, 0));
  const chat = chats().find((c) => c.name === name);
  if (split < 1 || !chat) throw new Error(`no plugin that is on answers ${name || to}`);
  await chat.reply(to.slice(split + 1), text);
}
