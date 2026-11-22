// The status module: knows whether each agent works, idles, asks you or hit an error, and
// whether each thread needs you or is ready. It learns this from the hooks the agent's harness
// runs, and from the agent's screen where no hook fires, and gives the word the sidebar and sc ps
// show for a thread. A lead's hooks only keep its state: nothing a lead does flags needs you.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { harnessNamed } from "../agents/harness.ts";
import { agentRuns, readSession } from "../agents/sessions.ts";
import { forQuestion, type Marks, quietSince } from "../agents/transport.ts";
import { errorText } from "../format.ts";
import { askHost, type Host, hostNamed, type PluginHost, pluginHost } from "../plugins/runtime.ts";
import { waitsOnFirstCheck } from "./decide.ts";
import { itemOpen } from "./inbox.ts";
import { leadOf } from "./lead.ts";
import { atRoundLimit, limitOf, limitWasDecided, passedReviewStage, roundOf } from "./ledger.ts";
import { clockTime, endWake, wakeAfterLimit } from "./limits.ts";
import { messageLead, stopDelivering, typeLeadNotes } from "./messages.ts";
import type { DaemonRequest } from "./requests.ts";
import { lastPushed } from "./round.ts";
import {
  AgentState,
  builderHarness,
  liveThreads,
  queuedForReview,
  readThread,
  record,
  Thread,
  threadName,
} from "./thread.ts";

// The status a host shows for a thread's builder.
export type Status = "working" | "idle" | "needs you" | "ready" | "error";

// Returns whether Skelcrew sees itself that the thread needs you: its builder's host plugin is
// missing, its builder asked with its harness's question tool, stopped without submitting, or its
// harness stopped on an error, or its flag is up, such as for an approval with green checks or the
// round limit. A merge you armed decides an approval, and arming one or sc start decides the
// latest review's round limit, so neither needs you then. A usage limit isn't one, as the builder
// is woken once it resets. Nor is a review that failed, which the lead can run again. The lead's
// items are apart, in the inbox.
export const needsYou = (thread: Thread) =>
  thread.needs_you_for !== null ||
  thread.asking ||
  (thread.turn_ended && (thread.status === "working" || thread.status === "waiting")) ||
  (thread.erred && !thread.limited) ||
  (thread.needs_you && !decided(thread));

// Returns why the thread needs you, as its word says, such as "question" or the action a mark
// asks of you, or null when it doesn't. sc ps and sc show print it, so you read what to do.
export function needsYouFor(thread: Thread): string | null {
  if (!needsYou(thread)) return null;
  return reasonOf(threadWord(thread, limitOf(thread)));
}

// Returns why a thread needs you from its word, as an action where the word says only what
// happened: an approved thread with green checks waits on you to merge it. The list keeps the
// word `approved`, beside the green mark that says the rest.
const reasonOf = (word: string) => (word === "approved" ? "ready to merge" : word);

// Returns whether you decided what the thread's flag waits on: the round limit was
// decided since its latest review, or a merge is armed on a thread ready to merge, which then
// merges by itself. An armed merge alone never decides the round limit, as its plan outlives the
// review it was armed after: a later review reaching the limit, such as after sc start, would
// then need nobody. Changes held are what the limit waits on, as an approval drops them.
const decided = (thread: Thread) =>
  limitWasDecided(thread) || (thread.merge_plan === "armed" && roundOf(thread).held === null);

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
  roundOf(thread).reviewing !== null ||
  (passedReviewStage(thread) &&
    thread.checks !== "failing" &&
    thread.conflicts === null &&
    roundOf(thread).telling === null);

// Returns whether the thread waits for you to merge it: Skelcrew's reviewer approved its latest
// round, or its flow has no review stage, with no newer one under way, and the latest poll found every check on its PR green,
// which polling marks by having it need you. A branch without a forge has no PR or checks, so
// its approval alone makes it ready. A PR that conflicts isn't ready to merge until the
// builder's next round, even when something else, such as its builder missing, makes the
// thread need you again.
export const readyToMerge = (thread: Thread) =>
  thread.needs_you &&
  roundOf(thread).submitting === null &&
  roundOf(thread).reviewing === null &&
  passedReviewStage(thread) &&
  (thread.checks === "passing" || thread.checks === null) &&
  (thread.pr === null || thread.ci_passed) &&
  thread.conflicts === null;

// Returns the thread's status, one of the five words a host can show, from the same fields and
// in the same order as its word in the sidebar, which then serves as the reason. A thread that
// failed, or whose harness stopped on an error, is in error. An approval with green checks is
// ready to merge, and so is a task whose flow skipped the review. Anything else that needs you comes next. A builder waiting out its usage limit
// idles, as it is woken once the limit resets, and so does one that isn't running. Otherwise
// the builder's own state says whether it works, such as idle after Esc while its thread still
// works. Before its first hook, a working thread works, and one waiting on its review idles.
export function statusOf(thread: Thread, maxRounds: number, now = Date.now()): Status {
  const word = threadWord(thread, maxRounds, now);
  // A mark shown as the word is an action for you, even on a thread that failed.
  if (thread.needs_you_for !== null && word === thread.needs_you_for) return "needs you";
  if (thread.status === "failed" || word === "error") return "error";
  // An approved thread with a merge armed merges by itself, so it waits rather than on you, as
  // does one its flow didn't review.
  if (word === "approved" || word === "not reviewed")
    return thread.merge_plan === "armed" ? "idle" : "ready";
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
  } else {
    db.run("UPDATE repositories SET lead_state = ? WHERE owner = ? AND repo = ?", [
      state,
      agent.owner,
      agent.repo,
    ]);
    reportLeadStatus(db, agent.owner, agent.repo);
  }
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

// The reports still being sent to each agent's host, by the same key, so they arrive in the
// order the changes happened.
const reporting = new Map<string, Promise<void>>();

// Reports the builder's status to its host, when the host is a plugin that provides status and
// the status changed since it last heard: working, idle, needs you, ready or error, with the
// thread's word as the reason, such as question or round limit. While the lead's item on it is
// open, it needs you, as the item asks you. Every change to a thread goes
// through record or keepState, which call this, so the host hears each one, from a hook, the
// screen check, CI or a review alike. It doesn't wait for the host, so the daemon never does.
// tmux shows no status, so its builders are left out, and Skelcrew's own list shows theirs.
export function reportStatus(db: Database, thread: Thread): void {
  if (thread.host === null || thread.host === "tmux" || thread.host_id === null) return;
  const host = pluginHost(db, thread.host);
  if (host === null || !host.status) return;
  let said: { status: Status; reason: string };
  try {
    const maxRounds = limitOf(thread);
    const status = statusOf(thread, maxRounds);
    const word = threadWord(thread, maxRounds);
    said = itemOpen(db, thread)
      ? { status: "needs you", reason: "asks you" }
      : { status, reason: status === "ready" ? reasonOf(word) : word };
  } catch (error) {
    console.log(`couldn't work out ${threadName(db, thread)}'s status: ${errorText(error)}`);
    return;
  }
  tellHost(host, thread.host_id, said, thread.folder, () =>
    reportStatus(db, readThread(db, thread.folder)),
  );
}

// Reports a repository's lead's status to its host, as reportStatus does a builder's, so a
// host's own apps show what the lead does too. A lead has no stage or round, so its status is
// what its hooks and the screen check last said: a question waiting on you needs you, and an
// error is one. A lead that hasn't said yet is working, as it is starting.
export function reportLeadStatus(db: Database, owner: string, repo: string): void {
  const row = db
    .query(
      "SELECT lead_host, lead_host_id, lead_state FROM repositories WHERE owner = ? AND repo = ?",
    )
    .get(owner, repo);
  const lead = z
    .object({
      lead_host: z.string().nullable(),
      lead_host_id: z.string().nullable(),
      lead_state: AgentState.nullable(),
    })
    .nullable()
    .parse(row);
  if (lead === null || lead.lead_host === null || lead.lead_host === "tmux") return;
  if (lead.lead_host_id === null) return;
  const host = pluginHost(db, lead.lead_host);
  if (host === null || !host.status) return;
  const state = lead.lead_state ?? "working";
  const said =
    state === "asking"
      ? { status: "needs you" as const, reason: "question" }
      : { status: state, reason: state };
  tellHost(host, lead.lead_host_id, said, `${owner}/${repo}'s lead`, () =>
    reportLeadStatus(db, owner, repo),
  );
}

// Tells a host that provides status what one of its sessions now shows, unless it heard that
// last. `who` names the agent in the log. Reports go after the ones before them, whether or not
// those got through. One that fails is forgotten and `again` is planned a little later, so a host
// that comes back hears the status then, as it is then.
function tellHost(
  host: PluginHost,
  id: string,
  said: { status: Status; reason: string },
  who: string,
  again: () => void,
): void {
  const key = `${host.plugin}/${id}`;
  const text = `${said.status} ${said.reason}`;
  if (reported.get(key) === text) return;
  reported.set(key, text);
  const question = { ask: "status", id, ...said };
  const sent = (reporting.get(key) ?? Promise.resolve())
    .then(() => askHost(host, question, z.unknown(), { timeout: statusTimeout }))
    .then(
      () => {},
      (error) => {
        if (reported.get(key) === text) reported.delete(key);
        console.log(`couldn't report ${who}'s status to ${host.plugin}: ${errorText(error)}`);
        retryReport(key, again);
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

// Runs `again` a little later, to tell the host an agent's status as it is then, after a report
// it failed to hear: without a later change, the host would go on showing an old one. One retry
// is planned per session at a time, and each failure plans the next, so a host that comes back
// hears the status then. An agent that has gone by then needs none.
function retryReport(key: string, again: () => void): void {
  if (retrying.has(key)) return;
  retrying.add(key);
  setTimeout(() => {
    retrying.delete(key);
    try {
      again();
    } catch {}
  }, retryAfter);
}

// Forgets what a host last heard from a session, as one starting under the same ID has told it
// nothing yet.
export const forgetStatus = (plugin: string, id: string) => reported.delete(`${plugin}/${id}`);

// Reports every live builder's status and every lead's to its host, for a daemon that starts,
// as the host heard nothing from it yet.
export function reportStatuses(db: Database): void {
  for (const thread of liveThreads(db)) reportStatus(db, thread);
  const leads = db.query("SELECT owner, repo FROM repositories").all();
  for (const { owner, repo } of z.array(LeadKey).parse(leads)) reportLeadStatus(db, owner, repo);
}

// Returns the word for what the thread is doing, given the rounds of changes it may have. Its
// status and needs you stay as they are: the word only describes them, from what they and the
// latest review say. Changes held past the round limit say so before a round under way. A round
// that failed keeps its submit or review saved.
// A thread can need you for a reason with no word of its own, such as a builder that couldn't be
// told about an event. Its word is then "needs you", rather than something untrue. A review or
// builder waiting out its harness's usage limit says when the limit resets, as this machine's
// clock shows it, such as "limit · 13:59", or only "limit" when the harness didn't say. Anything
// that needs you comes before a limit, which only waits.
export function threadWord(thread: Thread, maxRounds: number, now = Date.now()): string {
  const { status } = thread;
  const { verdict } = roundOf(thread);
  // A mark says in words what you must do, so it goes before what Skelcrew knows by itself, even
  // on a thread that is queued, failed or stopped, which the lead or you may mark too. Only a
  // question or an error the builder stopped on comes first, as you must answer it before
  // anything. A done thread has no mark, as its end clears it.
  const live = status === "working" || status === "waiting";
  const builderFirst = live && (thread.asking || (thread.erred && !thread.limited));
  if (thread.needs_you_for !== null && status !== "done" && !builderFirst)
    return thread.needs_you_for;
  // A thread that is queued, failed, stopped or is done says just that. Otherwise a question from
  // its builder comes first, then its harness stopping on an error, then why it needs you, then
  // what it is doing.
  if (status === "queued" || status === "failed" || status === "stopped" || status === "done")
    return status;
  const underWay = roundOf(thread).submitting !== null || roundOf(thread).reviewing !== null;
  if (thread.asking) return "question";
  if (thread.erred && !thread.limited) return "error";
  // The round limit and an approval say what you must do next, so they come before any other
  // reason the thread needs you. Changes held past the limit say so too after something else,
  // such as a conflict, cleared the thread's need of you: the task still waits on sc start, and
  // its CI passing must not read as waiting on checks.
  if (atRoundLimit(thread, maxRounds)) return "round limit";
  // A task whose flow has no review stage is never called approved, as nobody reviewed it.
  if (readyToMerge(thread)) return verdict === "not reviewed" ? "not reviewed" : "approved";
  // A round on a flow with no review stage fails on its submit, pushing it or opening its PR,
  // or on setting Skelcrew's check once it is pushed, never on a review, so it says which. The
  // note to the lead gives the error itself, such as the forge's.
  if (roundOf(thread).review_failed && waitsOnFirstCheck(thread))
    return roundOf(thread).submitting !== null ? "submit failed" : "check failed";
  // A review that failed doesn't need you, but says so until something sets the builder working
  // again, or a new round starts.
  if (roundOf(thread).review_failed && verdict === "timed out" && !underWay)
    return "review timed out";
  if (roundOf(thread).review_failed) return "review failed";
  // A builder that stopped without submitting needs you while the lead reads its last message,
  // but anything else it needs you for says so first. Its word doesn't claim a question, as it
  // may be only a reply.
  if (needsYou({ ...thread, turn_ended: false })) return "needs you";
  if (thread.turn_ended) return "turn ended";
  // Not needing you: a builder or a review waiting out a usage limit says until when.
  const limitWord = (reset: number | null) =>
    reset === null ? "limit" : `limit · ${clockTime(reset, now)}`;
  if (thread.erred && thread.limited) return limitWord(thread.limit_reset);
  if (thread.review_limited) return limitWord(thread.review_reset);
  // A submit on a flow with no review stage waits on checks while it is pushed and waits for CI's
  // first check. A review waiting for a place shows as queued, any other round under way as reviewing, and
  // a review's changes still waiting to be typed into the builder as changes. Otherwise it
  // works, or waits: on CI only for an approval, or a submit its flow doesn't review, and on the
  // builder after changes asked for.
  // Anything else only waits, as saying checks would claim CI is what it waits on.
  if (waitsOnFirstCheck(thread)) return "checks";
  if (queuedForReview(thread)) return "queued for review";
  if (underWay) return "reviewing";
  if (roundOf(thread).telling !== null) return "changes";
  if (status === "working") return "working";
  if (passedReviewStage(thread)) return "checks";
  return verdict === "changes" ? "changes" : "waiting";
}

// The builder asked you a question with AskUserQuestion, from Claude Code's PreToolUse hook.
// The thread needs you until the question is over, and the lead hears of it. A message being
// typed in now would answer the question for you, so that typing is cancelled, and the message
// waits until the question is over. `question` is what it asked, when its harness said.
export function questionAsked(
  db: Database,
  sessions: string,
  folder: string,
  question?: string,
): void {
  record(
    db,
    folder,
    { asking: true, said: question ?? null, handed: null },
    "its builder asked a question",
  );
  stopDelivering(db, folder, false, forQuestion);
  typeLeadNotes(db, sessions);
}

// The builder's turn ended, from its harness's Stop hook, with its last message and, when
// nothing in its clone is uncommitted, the commit it has checked out. A builder that didn't
// submit in that turn shows as turn ended, and its last message goes to the lead, who brings a
// question in it to you. One that told the lead in that turn with sc tell lead sends nothing
// more, as the lead already has its words. A turn with no new work while the last submit is
// still on its way waits on that submit instead. A turn that ends with a background job still
// running, such as a test run, isn't a stop: the harness starts a turn again once the job ends.
export function turnEnded(
  db: Database,
  sessions: string,
  folder: string,
  ended: {
    head?: string | undefined;
    message?: string | undefined;
    background?: boolean | undefined;
  },
): void {
  const thread = readThread(db, folder);
  // The builder still works, so it shows working and the lead hears nothing yet. The turn after
  // the job ends is the one judged.
  if (ended.background) {
    record(db, folder, { turn_ended: false, told_lead: false });
    return;
  }
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
    const replied = "its builder only replied, so it waits on CI";
    if (thread.status === "working" && roundOf(thread).reviewing === null)
      record(db, folder, { status: "waiting" }, replied);
    return;
  }
  // The lead has the builder's own words already, so it gets no note that the thread needs you.
  if (!thread.turn_ended)
    record(
      db,
      folder,
      { turn_ended: true, noting: thread.noting, said: ended.message ?? null, handed: null },
      "its builder stopped without submitting",
    );
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
  const erred = {
    erred: true,
    limited: false,
    limit_reset: null,
    said: message ?? null,
    handed: null,
  };
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

// Returns what a thread's row in the list of threads says of its armed merge, when ready or over
// the review, with what it waits on, or null with none. A thread that failed isn't polled, so it
// says so itself.
export function mergeShown(thread: Thread): string | null {
  if (thread.merge_plan !== "armed") return null;
  const kind = thread.merge_pinned === null ? "merges when ready" : "merges without approval";
  const waits = thread.status === "failed" ? "its thread, which failed" : thread.merge_waits;
  return waits === null ? kind : `${kind} · waiting on ${waits}`;
}

// Returns what Skelcrew's latest review on the thread's PR still asks for, one finding each, or
// none once it approved. A merge without approval names them before you say y, and files them as an
// issue once it merged, so they aren't lost.
export function openFindings(thread: Thread): string[] {
  const post = roundOf(thread).review_post;
  if (post === null || post.pr !== thread.pr || post.verdict !== "changes") return [];
  return post.findings;
}

// Returns what a question to merge without Skelcrew's approval says of that review, such as "It
// still asks: 1) Handle an empty file 2) Test the error". Each finding is put on one line, as the
// question is one line at your terminal.
export function stillAsks(thread: Thread): string {
  const findings = openFindings(thread).map(
    (finding, n) => `${n + 1}) ${finding.replace(/\s+/g, " ").trim()}`,
  );
  const asks = findings.length > 0 ? `It still asks: ${findings.join(" ")}` : "";
  if (roundOf(thread).reviewing === null) return asks || "Its reviewer hasn't approved it";
  return asks ? `${asks}, and its newest review is still running` : "Its review is still running";
}
