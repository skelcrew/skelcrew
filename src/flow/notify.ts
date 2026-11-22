// Messages to you while you are away: a needs-you note once per mark, the daily digest, and what
// the lead sends when you ask, each through the notifier plugin your config routes its type to.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { notifySettings } from "../config.ts";
import { errorText } from "../format.ts";
import { pluginsWithJob } from "../plugins/ask.ts";
import { callPlugin, installedPlugins } from "../plugins/plugin.ts";
import { removeControlCodes } from "../screen/look.ts";
import { backlogOf } from "./backlog.ts";
import { openTasks, prOf } from "./copy.ts";
import { repositories } from "./repo.ts";
import { needsYouFor } from "./status.ts";
import { Thread, taskName, threadName } from "./thread.ts";

const MessageType = z.enum(["needs-you", "digest", "asked"]);
type MessageType = z.infer<typeof MessageType>;

const Message = z.object({
  title: z.string(),
  body: z.string(),
  links: z.array(z.object({ name: z.string(), url: z.string() })),
});
type Message = z.infer<typeof Message>;

const perHour: Record<MessageType, number> = { "needs-you": 10, asked: 5, digest: 2 };

const hour = 60 * 60 * 1000;
const kept = 2 * 24 * hour;
const bodyLimit = 4000;

function routeOf(type: MessageType): string | null {
  if (type === "asked") return null;
  try {
    return notifySettings().notify[type] ?? null;
  } catch {
    return null;
  }
}

export function queueNotification(
  db: Database,
  type: MessageType,
  message: Message,
  now = Date.now(),
  via = routeOf(type),
): boolean {
  if (via === null) return false;
  db.run("DELETE FROM notifications WHERE queued < ? AND state != 'waiting'", [now - kept]);
  const recent = z
    .object({ n: z.number() })
    .parse(
      db
        .query("SELECT COUNT(*) AS n FROM notifications WHERE type = ? AND queued >= ?")
        .get(type, now - hour),
    ).n;
  if (recent >= perHour[type]) {
    console.log(
      `dropped a ${type} message, as at most ${perHour[type]} go each hour: ${removeControlCodes(message.title)}`,
    );
    return false;
  }
  const clean = {
    title: removeControlCodes(message.title).trim(),
    body: message.body.split(/\r?\n/).map(removeControlCodes).join("\n").slice(0, bodyLimit),
    links: message.links.map((link) => ({
      name: removeControlCodes(link.name),
      url: removeControlCodes(link.url),
    })),
  };
  db.run("INSERT INTO notifications (type, message, queued, via) VALUES (?, ?, ?, ?)", [
    type,
    JSON.stringify(clean),
    now,
    via,
  ]);
  return true;
}

let sending = false;

export async function sendNotifications(db: Database): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    const waiting = z
      .array(z.object({ id: z.number(), type: MessageType, message: z.string(), via: z.string() }))
      .parse(
        db
          .query(
            "SELECT id, type, message, via FROM notifications WHERE state = 'waiting' ORDER BY id",
          )
          .all(),
      );
    for (const { id, type, message, via } of waiting) {
      const state = await send(db, via, type, message);
      db.run("UPDATE notifications SET state = ? WHERE id = ?", [state, id]);
    }
  } finally {
    sending = false;
  }
}

async function send(
  db: Database,
  route: string,
  type: MessageType,
  saved: string,
): Promise<"sent" | "failed"> {
  try {
    const message = Message.parse(JSON.parse(saved));
    await callPlugin(db, route, { ask: "notify", type, ...message }, z.null());
    return "sent";
  } catch (error) {
    console.log(`couldn't send a ${type} message through ${route}: ${errorText(error)}`);
    return "failed";
  }
}

export function noticeNeedsYou(db: Database, thread: Thread): void {
  let mark: string | null;
  try {
    mark = needsYouFor(thread);
  } catch {
    return;
  }
  const had = z
    .object({ mark: z.string() })
    .nullable()
    .parse(db.query("SELECT mark FROM notified WHERE folder = ?").get(thread.folder));
  if (mark === null) {
    if (had !== null) db.run("DELETE FROM notified WHERE folder = ?", [thread.folder]);
    return;
  }
  if (had?.mark === mark) return;
  db.run("INSERT OR REPLACE INTO notified (folder, mark) VALUES (?, ?)", [thread.folder, mark]);
  const name = threadName(db, thread);
  const pr = thread.pr === null ? null : prOf(db, thread.owner, thread.repo, thread.pr);
  queueNotification(db, "needs-you", {
    title: `${name} needs you`,
    body: mark,
    links: pr === null ? [] : [{ name: `${name} #${pr.id}`, url: pr.link }],
  });
}

export function queueAsked(
  db: Database,
  asked: { subject: string; text: string; words: string | undefined; via: string },
): string {
  if (!asked.words?.trim())
    throw new Error(
      "sc notify sends the human a message only when they ask for one: write their words exactly to a file with your file-writing tool and add --asked-file <file>",
    );
  if (!pluginsWithJob(db, "notifier").includes(asked.via)) {
    const notifiers = pluginsWithJob(db, "notifier");
    const have =
      notifiers.length === 0
        ? "none is installed"
        : `the installed ones are ${notifiers.join(", ")}`;
    throw new Error(
      `${asked.via} isn't an installed notifier, so it can't reach the human: ${have}. The human adds one with sc plugin add -g`,
    );
  }
  const message = { title: asked.subject, body: asked.text, links: [] };
  if (!queueNotification(db, "asked", message, Date.now(), asked.via))
    throw new Error(`at most ${perHour.asked} such messages go each hour: try again later`);
  return `Sending "${removeControlCodes(asked.subject)}" to the human through ${asked.via}.`;
}

export function digestDue(now: Date, at: string, last: number | null): boolean {
  const [hours = 0, minutes = 0] = at.split(":").map(Number);
  const today = new Date(now);
  today.setHours(hours, minutes, 0, 0);
  return now.getTime() >= today.getTime() && (last === null || last < today.getTime());
}

const sectionLimit = 20;

export function digestOf(db: Database, since: number): Message {
  const links: Message["links"] = [];
  const parts = repositories(db).map((r) => {
    const threads = db
      .query("SELECT * FROM task_threads WHERE owner = ? AND repo = ? ORDER BY rowid")
      .all(r.owner, r.repo)
      .map((row) => Thread.parse(row));
    const named = (thread: Thread, state: string) => {
      const name = threadName(db, thread);
      const pr = thread.pr === null ? null : prOf(db, thread.owner, thread.repo, thread.pr);
      if (pr !== null) links.push({ name: `${name} #${pr.id}`, url: pr.link });
      return [name, state, pr === null ? "" : `#${pr.id}`].filter(Boolean).join(" · ");
    };
    const merged = threads
      .filter((t) => t.status === "done" && t.merged && (t.changed ?? 0) >= since)
      .map((t) => named(t, "merged"));
    const live = threads.filter((t) => t.status !== "done");
    const waits = live.flatMap((t) => {
      const mark = needsYouFor(t);
      return mark === null ? [] : [named(t, mark.slice(0, 80))];
    });
    const underWay = live.filter((t) => needsYouFor(t) === null).map((t) => named(t, t.status));
    const issues = openTasks(db, r.owner, r.repo)
      .filter((item) => !threads.some((t) => t.task === item.id))
      .map((item) => {
        const name = taskName(r.name, item.id);
        links.push({ name, url: item.link });
        return name;
      });
    const filed = backlogOf(db, r.owner, r.repo).map((t) => taskName(r.name, t.task));
    const section = (heading: string, names: string[]) => {
      if (names.length === 0) return [];
      const more = names.length - sectionLimit;
      const shown = names.slice(0, sectionLimit).map((name) => `  ${name}`);
      return [`${heading}:`, ...shown, ...(more > 0 ? [`  and ${more} more`] : [])];
    };
    const lines = [
      ...section("Merged", merged),
      ...section("Waits on you", waits),
      ...section("Under way", underWay),
      ...section("Backlog", [...issues, ...filed]),
    ];
    return [`${r.name} (${r.owner}/${r.repo})`, ...(lines.length ? lines : ["Nothing to report."])];
  });
  const body = parts.map((part) => part.join("\n")).join("\n\n");
  return { title: "Skelcrew's daily digest", body: body || "No repositories yet.", links };
}

export function queueDigest(db: Database, now = new Date()): void {
  if (routeOf("digest") === null) return;
  const { digestAt } = notifySettings();
  const last = z
    .object({ last: z.number().nullable() })
    .parse(
      db.query("SELECT MAX(queued) AS last FROM notifications WHERE type = 'digest'").get(),
    ).last;
  if (!digestDue(now, digestAt, last)) return;
  queueNotification(db, "digest", digestOf(db, last ?? now.getTime() - 24 * hour), now.getTime());
}

export function notifyProblems(db: Database): string[] {
  let routes: Record<"needs-you" | "digest", string | undefined>;
  try {
    routes = notifySettings().notify;
  } catch (error) {
    return [errorText(error)];
  }
  const installed = installedPlugins(db).map((plugin) => plugin.name);
  const notifiers = pluginsWithJob(db, "notifier");
  return (["needs-you", "digest"] as const).flatMap((type) => {
    const plugin = routes[type];
    if (plugin === undefined || notifiers.includes(plugin)) return [];
    const why = installed.includes(plugin)
      ? "which isn't a notifier plugin"
      : "which isn't installed: sc plugin add -g adds it";
    return [`Your config.yaml sends ${type} messages through ${plugin}, ${why}.`];
  });
}
