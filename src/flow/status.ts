// The status module: knows whether each agent works, idles, asks you or hit an error, and
// whether each thread needs you or is ready. It learns this from the hooks the agent's harness
// runs, and from the agent's screen where no hook fires, and gives the word the sidebar and sc ps
// show for a thread. A lead's hooks only keep its state: nothing a lead does flags needs you.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { harnessNamed } from "../agents/harness.ts";
import { agentRuns, readSession } from "../agents/sessions.ts";
import { forQuestion, type Marks, quietSince } from "../agents/transport.ts";
import { roundLimit } from "../config.ts";
import { askHost, type Host, hostNamed, pluginHost } from "../plugins/runtime.ts";
import { errorText } from "../say.ts";
import { pastRoundLimit } from "./decide.ts";
import { leadOf } from "./lead.ts";
import { clockTime, endWake, wakeAfterLimit } from "./limits.ts";
import { messageLead, stopDelivering, typeLeadNotes } from "./messages.ts";
import type { DaemonRequest } from "./requests.ts";
import { lastPushed } from "./round.ts";
import {
  type AgentState,
  builderHarness,
  liveThreads,
  queuedForReview,
  readThread,
  record,
  Thread,
} from "./thread.ts";

// The status a host shows for a thread's builder.
export type Status = "working" | "idle" | "needs you" | "ready" | "error";

// Returns whether the thread needs you: for a review, the round limit or an approval, for the
// builder's question, or for its harness stopping on an error. A usage limit isn't one, as the
// builder is woken once it resets. Nor is a builder that stopped without submitting: its last
// message goes to the lead, who brings a real question to you.
export const needsYou = (thread: Thread) =>
  thread.needs_you || thread.asking || (thread.erred && !thread.limited);

// Returns whether a builder that just ended its turn did so without sc submit, on any harness.
// Such a builder may have a question written as plain text, or be stuck, or have only replied,
// so its last message goes to the lead. One that submitted, or ran sc review, waits on its
// review. One asking with AskUserQuestion, or stopped on an error, already needs you. The status
// is not enough: a review can set it back to working while the builder that submitted is still
// finishing its turn.
export const endedWithoutSubmit = (thread: Thread) =>
  (thread.status === "working" || thread.status === "waiting") &&
  !thread.submitted &&
  !thread.asking &&
  !thread.erred;

// Returns whether a turn that ended without a submit still waits on the last one, so it doesn't
// show as turn ended. `unchanged` says the builder's clone holds nothing beyond its last submit.
// Such a turn most likely only answered a message, such as the lead's, so while that submit is
// reviewed, waits on CI or is approved, the thread waits on that.
export const waitsOnSubmit = (thread: Thread, unchanged: boolean) =>
  unchanged && submitStands(thread);

// Returns whether the thread's last submit still moves on without its builder: its review waits
// or runs, or it was approved and waits on CI or you. The thread's status doesn't matter: a
// comment on the PR sets it working again, yet the approval stands. Changes asked for, a failed
// check or a conflict all need the builder to work again, so a turn without new work doesn't
// wait on them.
const submitStands = (thread: Thread) =>
  thread.reviewing !== null ||
  (thread.verdict === "approve" &&
    thread.checks !== "failing" &&
    thread.conflicts === null &&
    thread.telling === null);

// Returns whether the thread waits for you to merge it: Skelcrew's reviewer approved its latest
// round, with no newer one under way, and the latest poll found every check on its PR green,
// which polling marks by having it need you. A branch without a forge has no PR or checks, so
// its approval alone makes it ready. A PR that conflicts isn't ready to merge until the
// builder's next round, even when something else, such as its builder missing, makes the
// thread need you again.
export const readyToMerge = (thread: Thread) =>
  thread.needs_you &&
  thread.submitting === null &&
  thread.reviewing === null &&
  thread.verdict === "approve" &&
  (thread.checks === "passing" || thread.checks === null) &&
  (thread.pr === null || thread.ci_passed) &&
  thread.conflicts === null;

// Returns the thread's status, one of the five words a host can show, from the same fields and
// in the same order as its word in the sidebar, which then serves as the reason. A thread that
// failed, or whose harness stopped on an error, is in error. An approval with green checks is
// ready to merge. Anything else that needs you comes next. A builder waiting out its usage limit
// idles, as it is woken once the limit resets, and so does one that isn't running. Otherwise
// the builder's own state says whether it works, such as idle after Esc while its thread still
// works. Before its first hook, a working thread works, and one waiting on its review idles.
export function statusOf(thread: Thread, maxRounds: number, now = Date.now()): Status {
  const word = threadWord(thread, maxRounds, now);
  if (thread.status === "failed" || word === "error") return "error";
  if (word === "approved") return "ready";
  if (needsYou(thread)) return "needs you";
  if (thread.erred && thread.limited) return "idle";
  if (thread.status !== "working" && thread.status !== "waiting") return "idle";
  return (thread.state ?? thread.status) === "working" ? "working" : "idle";
}

// Returns the state an agent is in once its harness ran a hook, by the request the hook made,
// or null for a request no hook makes. A message going in starts a turn, as an answer to
// AskUserQuestion goes on with one. A turn ends idle, normally or by Esc on Codex, or on an
// error Claude Code reported.
export function stateAfter(command: DaemonRequest["command"]): AgentState | null {
  switch (command) {
    case "question answered":
    case "question closed":
      return "working";
    case "question asked":
      return "asking";
    case "turn ended":
    case "turn interrupted":
      return "idle";
    case "turn failed":
      return "error";
    default:
      return null;
  }
}

// An agent as keepState takes it: a builder by its thread's folder, a lead by its repository.
type Agent = { folder: string } | { owner: string; repo: string };

// A repository whose lead is working, as the screen check reads it from the database.
const LeadKey = z.object({ owner: z.string(), repo: z.string() });

// The screen check's last look at each working agent, by the key agentKey gives it: what its
// screen showed, and whether that look found it out of a turn.
const lastLook = new Map<string, { screen: string; quiet: boolean }>();

// Returns the key an agent goes by in lastLook: a thread's folder, or a lead's owner/name.
// Folders hold no /, so the two never meet.
const agentKey = (agent: Agent) =>
  "folder" in agent ? agent.folder : `${agent.owner}/${agent.repo}`;

// How many times each agent's state has been kept, by the key agentKey gives it, so a look at
// its screen that took a while can tell the state changed meanwhile, earlier look or not.
const stateChanges = new Map<string, number>();

// Keeps what an agent is doing: a builder's state on its thread, a lead's on its repository.
// Not logged, as it changes with every turn. A new state forgets the screen check's last look,
// and makes any look under way count for nothing, so a mark gone before the change can't turn
// the new turn idle.
export function keepState(db: Database, agent: Agent, state: AgentState): void {
  const key = agentKey(agent);
  lastLook.delete(key);
  stateChanges.set(key, (stateChanges.get(key) ?? 0) + 1);
  if ("folder" in agent) {
    db.run("UPDATE threads SET state = ? WHERE folder = ?", [state, agent.folder]);
    reportStatus(db, readThread(db, agent.folder));
  } else
    db.run("UPDATE repositories SET lead_state = ? WHERE owner = ? AND repo = ?", [
      state,
      agent.owner,
      agent.repo,
    ]);
}

// Looks at the screen of each running agent whose state is working, and makes it idle once two
// looks in a row find it out of a turn: its harness's busy mark gone, or sitting still at a bare
// prompt, as the agent's own text, such as a reply quoting it. Only a live status line counts,
// as when typing, so such a reply can't keep it working forever. Two gaps have no hook: Esc on
// Claude Code, and an error on Codex, such as an unknown model, which prints it and sits at its
// prompt. One look isn't enough: right after a message goes in, the mark can take a moment to
// show. Neither gap flags needs you: after Esc you are looking at the agent anyway. The daemon
// runs it every two seconds. Each agent is looked at on its own, without waiting: a slow or hung
// host holds up only its own agents' looks, and one that fails leaves the others' to go on.
export function noticeIdleScreens(db: Database, sessions: string): void {
  // The working agents: each builder still at work on its thread, on whichever host it runs, and
  // each lead, on whichever host it runs. An agent whose host plugin is gone can't be looked at.
  const working: { key: Agent; host: Host; name: string; marks: Marks }[] = [];
  const threads = db
    .query(
      "SELECT * FROM task_threads WHERE state = 'working' AND status IN ('working', 'waiting')",
    )
    .all()
    .map((row) => Thread.parse(row));
  for (const thread of threads) {
    const host = hostNamed(db, sessions, thread.host ?? "tmux");
    const name = thread.host_id ?? thread.folder;
    if (host !== null)
      working.push({ key: thread, host, name, marks: builderHarness(thread).marks });
  }
  const leads = db
    .query("SELECT owner, repo FROM repositories WHERE lead_state = 'working'")
    .all()
    .map((row) => LeadKey.parse(row));
  for (const lead of leads) {
    const { name, harness, host, hostId } = leadOf(db, lead.owner, lead.repo);
    const on = hostNamed(db, sessions, host);
    if (on !== null)
      working.push({
        key: lead,
        host: on,
        name: hostId ?? name,
        marks: harnessNamed(harness ?? "claude").marks,
      });
  }
  // An agent no longer working is forgotten. Each other one gets a look, unless the last is
  // still under way.
  const keys = new Set(working.map((agent) => agentKey(agent.key)));
  for (const key of lastLook.keys()) if (!keys.has(key)) lastLook.delete(key);
  for (const agent of working) {
    const key = agentKey(agent.key);
    if (looking.has(key)) continue;
    looking.add(key);
    lookAt(db, agent, key)
      .catch((error) => console.log(`couldn't look at ${agent.name}'s screen: ${errorText(error)}`))
      .finally(() => looking.delete(key));
  }
}

// The agents being looked at now, by the key agentKey gives them.
const looking = new Set<string>();

// Takes one look at a working agent's screen for noticeIdleScreens. It goes idle when the last
// look found it out of a turn too. Otherwise this look is remembered for the next. A new state
// kept while it looked makes this one count for nothing, as it may show the turn before, even
// with no earlier look to compare. An agent that isn't running has nothing to remember.
async function lookAt(
  db: Database,
  agent: { key: Agent; host: Host; name: string; marks: Marks },
  key: string,
): Promise<void> {
  const before = lastLook.get(key);
  const changes = stateChanges.get(key);
  const runs = await agentRuns(agent.host, agent.name);
  const screen = runs ? await readSession(agent.host, agent.name) : "";
  if (stateChanges.get(key) !== changes || lastLook.get(key) !== before) return;
  if (!runs) return void lastLook.delete(key);
  const quiet = quietSince(before?.screen, screen, agent.marks);
  if (quiet && before?.quiet) keepState(db, agent.key, "idle");
  else lastLook.set(key, { screen, quiet });
}

// The status last reported to a host for each builder, by its host and its ID there, so the host
// hears only of changes. A daemon that starts again reports each one afresh.
const reported = new Map<string, string>();

// How long a host may take to hear a status, in milliseconds. Showing a status is quick, so one
// that takes longer is hung, and is ended so the reports after it still go.
const statusTimeout = 5000;

// The reports still being sent to each builder's host, by the same key, so they arrive in the
// order the changes happened.
const reporting = new Map<string, Promise<void>>();

// Reports the builder's status to its host, when the host is a plugin that provides status and
// the status changed since it last heard: working, idle, needs you, ready or error, with the
// thread's word as the reason, such as question or round limit. Every change to a thread goes
// through record or keepState, which call this, so the host hears each one, from a hook, the
// screen check, CI or a review alike. It doesn't wait for the host, so the daemon never does.
// tmux shows no status, so its builders are left out, and Skelcrew's own list shows theirs.
export function reportStatus(db: Database, thread: Thread): void {
  if (thread.host === null || thread.host === "tmux" || thread.host_id === null) return;
  const host = pluginHost(db, thread.host);
  if (host === null || !host.status) return;
  let said: { status: Status; reason: string };
  try {
    const maxRounds = roundLimit(thread);
    said = { status: statusOf(thread, maxRounds), reason: threadWord(thread, maxRounds) };
  } catch (error) {
    console.log(`couldn't work out ${thread.folder}'s status: ${errorText(error)}`);
    return;
  }
  const id = thread.host_id;
  const key = `${host.plugin}/${id}`;
  const text = `${said.status} ${said.reason}`;
  if (reported.get(key) === text) return;
  reported.set(key, text);
  // After the reports before it, whether or not they got through. One that fails is forgotten,
  // so the next change, or the daemon's next start, says it again.
  const question = { ask: "status", id, ...said };
  const sent = (reporting.get(key) ?? Promise.resolve())
    .then(() => askHost(host, question, z.unknown(), { timeout: statusTimeout }))
    .then(
      () => {},
      (error) => {
        if (reported.get(key) === text) reported.delete(key);
        console.log(
          `couldn't report ${thread.folder}'s status to ${host.plugin}: ${errorText(error)}`,
        );
        retryReport(db, thread.folder, key);
      },
    );
  reporting.set(key, sent);
  sent.then(() => {
    if (reporting.get(key) === sent) reporting.delete(key);
  });
}

// How long to wait before telling a host again a status it failed to hear, in milliseconds.
const retryAfter = 5000;

// The sessions a report is planned again for, by the same key as reported.
const retrying = new Set<string>();

// Tells the host the thread's status again a little later, as it is then, after a report it
// failed to hear: without a later change, the host would go on showing an old one. One retry is
// planned per session at a time, and each failure plans the next, so a host that comes back hears
// the status then. A thread that has gone by then needs none.
function retryReport(db: Database, folder: string, key: string): void {
  if (retrying.has(key)) return;
  retrying.add(key);
  setTimeout(() => {
    retrying.delete(key);
    try {
      reportStatus(db, readThread(db, folder));
    } catch {}
  }, retryAfter);
}

// Forgets what a host last heard from a session, as one starting under the same ID has told it
// nothing yet.
export const forgetStatus = (plugin: string, id: string) => reported.delete(`${plugin}/${id}`);

// Reports every live builder's status to its host, for a daemon that starts, as the host heard
// nothing from it yet.
export function reportStatuses(db: Database): void {
  for (const thread of liveThreads(db)) reportStatus(db, thread);
}

// Returns the word for what the thread is doing, given the rounds of changes it may have. Its
// status and needs you stay as they are: the word only describes them, from what they and the
// latest review say. Past the limit a thread goes on needing you while its builder submits, so
// that comes before a round under way. A round that failed keeps its submit or review saved.
// A thread can need you for a reason with no word of its own, such as a builder that couldn't be
// told about an event. Its word is then "needs you", rather than something untrue. A review or
// builder waiting out its harness's usage limit says when the limit resets, as this machine's
// clock shows it, such as "limit · 13:59", or only "limit" when the harness didn't say. Anything
// that needs you comes before a limit, which only waits.
export function threadWord(thread: Thread, maxRounds: number, now = Date.now()): string {
  const { status, verdict } = thread;
  // A thread that failed, stopped or is done says just that. Otherwise a question from its builder
  // comes first, then its harness stopping on an error, then why it needs you, then what it is
  // doing.
  if (status === "failed" || status === "stopped" || status === "done") return status;
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  if (thread.asking) return "question";
  if (thread.erred && !thread.limited) return "error";
  // The round limit and an approval say what you must do next, so they come before any other
  // reason the thread needs you.
  const past = thread.needs_you && pastRoundLimit(thread, maxRounds);
  const failed = underWay || verdict === "failed";
  if (past) return "round limit";
  if (readyToMerge(thread)) return "approved";
  if (thread.needs_you && verdict === "timed out" && !underWay) return "review timed out";
  if (thread.needs_you) return failed ? "review failed" : "needs you";
  // Not needing you: a builder that stopped without submitting waits on the lead, who got its
  // last message. Its word doesn't claim a question, as it may be only a reply.
  if (thread.turn_ended) return "turn ended";
  // Not needing you: a builder or a review waiting out a usage limit says until when.
  const limitWord = (reset: number | null) =>
    reset === null ? "limit" : `limit · ${clockTime(reset, now)}`;
  if (thread.erred && thread.limited) return limitWord(thread.limit_reset);
  if (thread.review_limited) return limitWord(thread.review_reset);
  // A review waiting for a place shows as queued, any other round under way as reviewing, and
  // a review's changes still waiting to be typed into the builder as changes. Otherwise it
  // works or waits on checks.
  if (queuedForReview(thread)) return "queued for review";
  if (underWay) return "reviewing";
  if (thread.telling !== null) return "changes";
  return status === "working" ? "working" : "checks";
}

// The builder asked you a question with AskUserQuestion, from Claude Code's PreToolUse hook.
// The thread needs you until the question is over, and the lead hears of it. A message being
// typed in now would answer the question for you, so that typing is cancelled, and the message
// waits until the question is over.
export function questionAsked(db: Database, sessions: string, folder: string): void {
  record(db, folder, { asking: true }, "its builder asked a question");
  stopDelivering(db, folder, false, forQuestion);
  typeLeadNotes(db, sessions);
}

// The builder's turn ended, from its harness's Stop hook, with its last message and, when
// nothing in its clone is uncommitted, the commit it has checked out. A builder that didn't
// submit in that turn shows as turn ended, and its last message goes to the lead, who brings a
// question in it to you. One that told the lead in that turn with sc tell lead sends nothing
// more, as the lead already has its words. A turn with no new work while the last submit is
// still on its way waits on that submit instead.
export function turnEnded(
  db: Database,
  sessions: string,
  folder: string,
  ended: { head?: string | undefined; message?: string | undefined },
): void {
  const thread = readThread(db, folder);
  // The lead reads the builder's own words, as a message from it, so a question need not end
  // in a question mark to reach you. A harness that gave none still says the turn ended.
  const said = ended.message ? `, saying:\n\n${ended.message}` : ".";
  const forward = endedWithoutSubmit(thread) && !thread.told_lead;
  if (forward) messageLead(db, sessions, thread, `My turn ended without a submit${said}`);
  // The turn is over, so a turn after it with nothing typed in, such as when a background task
  // ends, starts with the lead not yet told. Cleared after forwarding, which marks it told.
  if (readThread(db, folder).told_lead) record(db, folder, { told_lead: false });
  if (!endedWithoutSubmit(thread)) return;
  const unchanged = ended.head !== undefined && ended.head === lastPushed(thread);
  if (waitsOnSubmit(thread, unchanged)) {
    // A comment on an approved PR set the thread working. The builder only answered it, so the
    // thread waits on its approved submit again, and the next poll can find it ready to merge.
    // A review under way sets the status itself once it ends.
    if (thread.status === "working" && thread.reviewing === null)
      record(db, folder, { status: "waiting" }, "its builder only replied, so it waits on CI");
    return;
  }
  if (!thread.turn_ended)
    record(db, folder, { turn_ended: true }, "its builder stopped without submitting");
}

// The builder's turn ended on an error, from Claude Code's StopFailure hook, with the kind of
// error and its message. A usage limit, or a rate limit, passes by itself, so the builder is
// woken once it resets, and the thread doesn't need you for it. Any other error does.
export function turnFailed(
  db: Database,
  sessions: string,
  thread: Thread,
  error: string | undefined,
  message: string | undefined,
): void {
  // Only the kind of error the hook names decides: its message can hold the builder's own last
  // words, such as about the rate limiting it was writing. The message only gives the reset.
  const said = message ?? "";
  if (error === "rate_limit") {
    const reset = builderHarness(thread).usageLimit(said, Date.now())?.reset ?? null;
    const change = { erred: true, limited: true, limit_reset: reset };
    record(db, thread.folder, change, `its builder's harness reached its usage limit: ${said}`);
    wakeAfterLimit(db, sessions, thread.folder);
    return;
  }
  // A limit it stopped on before is over: this error is new, and needs you, so the wake
  // planned for the old one never types "continue" over it.
  endWake(thread.folder);
  const erred = { erred: true, limited: false, limit_reset: null };
  record(db, thread.folder, erred, "its builder's harness stopped on an error");
  typeLeadNotes(db, sessions);
}

// AskUserQuestion returned your answer, from Claude Code's PostToolUse hook, and the builder
// goes on in the same turn, so a submit earlier in it still counts.
export function questionClosed(db: Database, folder: string): void {
  // Your answer starts a new stretch of work all the same, which the sidebar times, as anything
  // typed into the builder does.
  db.run("UPDATE threads SET working_since = ? WHERE folder = ?", [Date.now(), folder]);
  if (readThread(db, folder).asking)
    record(db, folder, { asking: false }, "its builder's question is over");
}

// Something was typed into the builder, from its harness's UserPromptSubmit hook: a review's
// changes, a message from the lead, or your answer. It starts a new turn, and ends whatever the
// builder was waiting on you for.
export function questionAnswered(db: Database, folder: string): void {
  const thread = readThread(db, folder);
  // The new stretch of work is timed by the sidebar. Not logged, as only the sidebar shows it.
  db.run("UPDATE threads SET working_since = ? WHERE folder = ?", [Date.now(), folder]);
  // Run before every message typed into the builder, so only a question or an error that
  // was open is logged. Typing to a builder that stopped on an error means you fixed it,
  // such as with /login, so it ends the error as it ends a question. A usage limit it
  // stopped on ends too, as the builder now works again or meets it again. Typing to one
  // that stopped without submitting gives it work again, whether you typed or the lead told it.
  // Each message starts a new turn, with no submit and no sc tell lead in it yet.
  const over = {
    asking: false,
    turn_ended: false,
    erred: false,
    submitted: false,
    told_lead: false,
    limited: false,
    limit_reset: null,
  };
  // The builder has something to work on, so a "continue" still waiting to be typed must
  // not land. A wake already typing has cleared the error, so it is ended whatever the
  // flags say. One whose "continue" ran this hook has nothing left to type.
  endWake(folder);
  if (thread.asking) record(db, folder, over, "its builder's question is over");
  else if (thread.erred) record(db, folder, over, "its builder was typed to after its error");
  else if (thread.submitted || thread.told_lead || thread.turn_ended) record(db, folder, over);
}

// Returns what a thread's row in the list of threads says of its merge when ready, with what it
// waits on, or null with none. A thread that failed isn't polled, so it says so itself.
export function mergeShown(thread: Thread): string | null {
  if (thread.merge_plan !== "armed") return null;
  const waits = thread.status === "failed" ? "its thread, which failed" : thread.merge_waits;
  return waits === null ? "merges when ready" : `merges when ready · waiting on ${waits}`;
}
