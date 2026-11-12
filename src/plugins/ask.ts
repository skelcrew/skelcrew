// What Skelcrew's flow asks a repository's tracker and forge, through their call command, and
// finding which plugins those are. The flow knows what a tracker or forge does, never which
// plugin does it.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { repositoryTracker } from "../config.ts";
import type { Repository } from "../db.ts";
import { Item, type Task } from "../flow/copy.ts";
import { callPlugin, installedPlugins, readManifest } from "./plugin.ts";

// Returns the installed plugins that do the job.
export function pluginsFor(db: Database, job: "tracker" | "forge"): string[] {
  // A plugin whose manifest can't be read does no job, so one broken plugin stops nothing else.
  return installedPlugins(db)
    .filter((plugin) => {
      try {
        return readManifest(plugin.folder).jobs.includes(job);
      } catch {
        return false;
      }
    })
    .map((plugin) => plugin.name);
}

// Returns the repository's tracker, or null. Its forge is its tracker when the forge can be one,
// as GitHub can, so a repository on GitHub plans in its issues with nothing to set up. Its
// skelcrew.yaml can name another, used only when installed, or say none, for git alone. A file
// that can't be read names none.
export function trackerOf(db: Database, repository: Repository): string | null {
  let named: string | undefined;
  try {
    named = repositoryTracker(repository);
  } catch {
    return null;
  }
  if (named === "none") return null;
  // A named tracker that isn't installed gives none, not the forge: its tasks are planned elsewhere.
  const tracker = named ?? repository.forge;
  return tracker !== null && pluginsFor(db, "tracker").includes(tracker) ? tracker : null;
}

// Returns the repository's forge: the plugin that claimed its remote, while it is installed,
// or null.
export function forgeOf(db: Database, repository: Repository): string | null {
  const { forge } = repository;
  return forge !== null && pluginsFor(db, "forge").includes(forge) ? forge : null;
}

// Returns the repository's tracker and forge with the jobs each does for it, one entry per
// plugin, so a plugin that is both is asked once.
export function pluginsOf(
  db: Database,
  repository: Repository,
): { plugin: string; jobs: ("tracker" | "forge")[] }[] {
  const tracker = trackerOf(db, repository);
  const forge = forgeOf(db, repository);
  // Such as GitHub, which holds both the issues and the PRs.
  if (tracker !== null && tracker === forge)
    return [{ plugin: tracker, jobs: ["tracker", "forge"] }];
  return [
    ...(tracker === null ? [] : [{ plugin: tracker, jobs: ["tracker" as const] }]),
    ...(forge === null ? [] : [{ plugin: forge, jobs: ["forge" as const] }]),
  ];
}

// The key a forge gives a repository is owner/name, which becomes folders, so neither part
// may climb out of Skelcrew's.
const Part = z.string().regex(/^(?!\.\.?$)[\w.-]+$/);
// A forge's answer when the remote is its own: the repository's key, short name, link and
// clone URL, whether you can push to it and whether it is a fork.
const Claimed = z.object({
  key: z.string().refine((key) => {
    const parts = key.split("/");
    return parts.length === 2 && parts.every((part) => Part.safeParse(part).success);
  }, "must be owner/name"),
  name: Part,
  link: z.string(),
  clone: z.string().min(1),
  push: z.boolean(),
  fork: z.boolean(),
  // Who commits in the forge's name, such as its app's bot, as git writes an author.
  author: z
    .object({ name: z.string().regex(/^[^<>\n]+$/), email: z.string().regex(/^[^<>\s]+$/) })
    .optional(),
});
export type Claimed = z.infer<typeof Claimed> & { forge: string };

// Asks each installed forge whether the remote is its own, and returns the first one's
// answer, with its name, or null when none claims it. A forge that claims it but fails, such
// as one whose app isn't installed there, throws its reason, as the repository is its own.
export async function claims(db: Database, remote: string): Promise<Claimed | null> {
  // Asked in name order, so the same forge wins each time two would claim one remote.
  for (const forge of pluginsFor(db, "forge")) {
    const claimed = await callPlugin(db, forge, { ask: "claims", remote }, Claimed.nullable());
    if (claimed) return { ...claimed, forge };
  }
  return null;
}

// The repository as a plugin knows it: the key its forge gave it.
const keyOf = (repository: Repository) => `${repository.owner}/${repository.repo}`;

// A plugin's answer to what changed: the issues and PRs, and what to pass as `next` the next
// time, or null to ask for everything open again.
const Changed = z.object({ items: z.array(Item), next: z.string().nullable() });

// Asks a plugin what changed in the repository since `next`, or everything open without it,
// as the jobs it does there, with the PRs Skelcrew watches. Returns its items and the next `next`.
export async function changed(
  db: Database,
  plugin: string,
  repository: Repository,
  jobs: ("tracker" | "forge")[],
  next: string | null,
  prs: number[],
): Promise<z.infer<typeof Changed>> {
  return callPlugin(
    db,
    plugin,
    { ask: "changed", repository: keyOf(repository), jobs, next, prs },
    Changed,
  );
}

// Returns the repository's tracker, or throws saying it has none, for what only a tracker does.
function trackerFor(db: Database, repository: Repository): string {
  const tracker = trackerOf(db, repository);
  if (tracker === null)
    throw new Error(
      `${repository.name} has no tracker: tell the lead what to do, and it starts a thread with sc start ${repository.name} "<title>" "<body>"`,
    );
  return tracker;
}

// Returns the repository's forge, or throws saying it has none, for what only a forge does.
function forgeFor(db: Database, repository: Repository): string {
  const forge = forgeOf(db, repository);
  if (forge === null) throw new Error(`${repository.name} has no forge`);
  return forge;
}

// Creates a task in the repository's tracker and returns it as an item.
export async function createTask(
  db: Database,
  repository: Repository,
  title: string,
  body: string,
): Promise<Task> {
  const task = await callPlugin(
    db,
    trackerFor(db, repository),
    { ask: "create task", repository: keyOf(repository), title, body },
    Item,
  );
  // Item also covers PRs, and only a task is right here.
  if (task.kind !== "task")
    throw new Error("the tracker answered with something that isn't a task");
  return task;
}

// Tells the tracker Skelcrew took the task, so you can see on it that Skelcrew started work.
export async function took(db: Database, repository: Repository, task: string): Promise<void> {
  await callPlugin(
    db,
    trackerFor(db, repository),
    { ask: "took", repository: keyOf(repository), task },
    z.null(),
  );
}

// Tells the forge Skelcrew typed a person's comment or review on the PR into its builder, so
// they can see on the PR that it was picked up. GitHub reacts with 👀.
export async function markSeen(
  db: Database,
  repository: Repository,
  item: { pr: number; kind: "review" | "comment"; id: string },
): Promise<void> {
  await callPlugin(
    db,
    forgeFor(db, repository),
    { ask: "seen", repository: keyOf(repository), ...item },
    z.null(),
  );
}

// Opens a PR from the branch in the repository's forge and returns its number, or the number
// of the PR already open from that branch.
export async function openPr(
  db: Database,
  repository: Repository,
  pr: { branch: string; base: string; title: string; body: string },
): Promise<number> {
  const opened = await callPlugin(
    db,
    forgeFor(db, repository),
    { ask: "open pr", repository: keyOf(repository), ...pr },
    z.object({ number: z.number().int().positive() }),
  );
  return opened.number;
}

// Closes the PR and deletes its branch on the forge, for sc rm, first posting the comment
// when there is one, so the PR says why it closed.
export async function closePr(
  db: Database,
  repository: Repository,
  pr: { pr: number; branch: string; comment: string | null },
): Promise<void> {
  await callPlugin(
    db,
    forgeFor(db, repository),
    { ask: "close pr", repository: keyOf(repository), ...pr },
    z.null(),
  );
}

// Posts a review's verdict and body on the PR, for the commit it covers, and returns its ID.
export async function postReview(
  db: Database,
  repository: Repository,
  review: { pr: number; commit: string; verdict: "approve" | "changes"; body: string },
): Promise<string> {
  const posted = await callPlugin(
    db,
    forgeFor(db, repository),
    { ask: "review", repository: keyOf(repository), ...review },
    z.object({ id: z.string() }),
  );
  return posted.id;
}

// Sets Skelcrew's own check on the commit, so branch protection can require the review's verdict.
export async function setStatus(
  db: Database,
  repository: Repository,
  status: { commit: string; state: "pending" | "success" | "failure"; description: string },
): Promise<void> {
  await callPlugin(
    db,
    forgeFor(db, repository),
    { ask: "status", repository: keyOf(repository), ...status },
    z.null(),
  );
}

// Returns the end of a failed check's log, as the forge keeps it.
export async function failedLog(
  db: Database,
  repository: Repository,
  check: string,
): Promise<string> {
  const read = await callPlugin(
    db,
    forgeFor(db, repository),
    { ask: "log", repository: keyOf(repository), check },
    z.object({ log: z.string() }),
  );
  return read.log;
}

// Asks a plugin to start passing wake-ups for the repository to the address, or with `stop`
// to stop. A plugin with no wake-ups does nothing.
export async function wake(
  db: Database,
  plugin: string,
  repository: Repository,
  url: string,
  stop = false,
): Promise<void> {
  await callPlugin(
    db,
    plugin,
    { ask: stop ? "unwake" : "wake", repository: keyOf(repository), url },
    z.null(),
  );
}
