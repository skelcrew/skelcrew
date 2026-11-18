// Trust for a repository's .agents/: the version of it you approved, for each repository, and
// reading its files. Its role instructions decide what agents are told, so only a version you
// approved ever steers them, and a change to it waits until you approve that too.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { cloneDir, configDir } from "./paths.ts";

// A repository, by its owner and name.
type Place = { owner: string; repo: string };

// Returns the file of what you approved, kept with your settings so a clone can't bring its own
// yes. Each repository's line holds the git tree of the .agents/ you approved, or `none` when you
// chose the built-in roles over the one it had.
const approvalsFile = () => join(configDir(), "approved-agents.yaml");
// A tree is checked to be one, as it is handed to git, where a line starting with a dash would
// read as an option.
const Approvals = z.record(z.string(), z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64}|none)$/));

// Returns the file of the .agents/ sc init wrote, for each repository, kept beside what you
// approved: each line holds the git tree of the files as written, approved once the default
// branch has exactly that tree.
const writtenFile = () => join(configDir(), "written-agents.yaml");

// Returns the approvals in `file`, checked, or none when there is no file.
function readFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const read = Approvals.safeParse(parse(readFileSync(file, "utf8")) ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Saves the approvals in `file`.
function writeFile(file: string, approvals: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(file, Object.keys(approvals).length ? stringify(approvals) : "");
}

// Returns every repository's approval, checked, or none before you approved anything. An
// .agents/ sc init wrote is approved here first, once its repository's default branch has it
// exactly as written: those files are the built-in defaults with your own harness and model, so
// you would only be asked about what you wrote yourself. Until it is pushed, the default branch
// doesn't have it, and approving it then would tell the lead it waits for you.
function readApprovals(): Record<string, string> {
  for (const [name, tree] of Object.entries(readFile(writtenFile()))) {
    const [owner = "", repo = ""] = name.split("/");
    if (agentsOnDefaultBranch({ owner, repo }) === tree) approveAgents({ owner, repo }, tree);
  }
  return readFile(approvalsFile());
}

// Runs git in Skelcrew's clone of the repository and returns what it printed, or null when it
// failed, as it does for a tree or path the clone doesn't have.
function gitIn(place: Place, args: string[]): string | null {
  const run = Bun.spawnSync(["git", "-C", cloneDir(place.owner, place.repo), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.success ? run.stdout.toString() : null;
}

// Returns the git tree of the .agents/ folder on the repository's default branch, which Skelcrew's
// clone is on, or null when it has none. An .agents/ that is a link or a file counts as none.
export function agentsOnDefaultBranch(place: Place): string | null {
  const found = gitIn(place, ["rev-parse", "--verify", "--quiet", "HEAD:.agents"])?.trim();
  // A link is a blob in git, so only a real folder is a tree.
  return found && gitIn(place, ["cat-file", "-t", found])?.trim() === "tree" ? found : null;
}

// Returns the tree of the .agents/ you approved for the repository, or null for the built-in
// roles: when you approved none, chose the built-in ones, or were never asked.
export function approvedAgents(place: Place): string | null {
  const approved = readApprovals()[`${place.owner}/${place.repo}`];
  return approved === undefined || approved === "none" ? null : approved;
}

// Returns whether you have answered for the repository's .agents/ yet, yes or no.
export const agentsAnswered = (place: Place): boolean =>
  readApprovals()[`${place.owner}/${place.repo}`] !== undefined;

// Returns whether the .agents/ on the default branch isn't the one you approved, so new tasks
// keep the approved version and the repository needs you to run sc repo trust.
export const agentsWaiting = (place: Place): boolean =>
  agentsOnDefaultBranch(place) !== approvedAgents(place);

// Approves a tree of .agents/ for the repository, or the built-in roles with null. A ref in
// Skelcrew's clone keeps the tree, so a force push that drops it from the default branch can't
// let git clean it away from tasks that started on it.
// Any answer settles what sc init wrote for the repository, so that is forgotten. The approvals
// are read raw here, as reading them through readApprovals would approve what sc init wrote
// again.
export function approveAgents(place: Place, tree: string | null): void {
  const name = `${place.owner}/${place.repo}`;
  if (tree !== null && gitIn(place, ["update-ref", `refs/skelcrew/agents/${tree}`, tree]) === null)
    throw new Error(`Skelcrew's clone of ${name} has no tree ${tree}`);
  writeFile(approvalsFile(), { ...readFile(approvalsFile()), [name]: tree ?? "none" });
  forgetWritten(name);
}

// Forgets the .agents/ sc init wrote for the repository named `name`, as owner/repo.
function forgetWritten(name: string): void {
  const written = readFile(writtenFile());
  if (written[name] === undefined) return;
  const { [name]: _gone, ...rest } = written;
  writeFile(writtenFile(), rest);
}

// Forgets what you approved for the repository, for sc repo rm, so adding it again asks again.
export function forgetAgents(place: Place): void {
  const name = `${place.owner}/${place.repo}`;
  forgetWritten(name);
  if (!agentsAnswered(place)) return;
  const { [name]: _gone, ...rest } = readApprovals();
  writeFile(approvalsFile(), rest);
}

// Remembers the .agents/ sc init just wrote in `checkout`, a checkout of the repository, so it
// is approved once the default branch has it exactly as written. Its git tree is worked out in
// the checkout, as Skelcrew's clone doesn't have it before it is pushed, through an index of
// its own, so what you have staged there stays as it is. One that git can't add, such as one
// your .gitignore leaves out, is not remembered, and is asked about as any other.
export function approveWhenPushed(place: Place, checkout: string): void {
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(folder, "index") };
    const git = (args: string[]) =>
      Bun.spawnSync(["git", "-C", checkout, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (!git(["add", "--", ".agents"]).success) return;
    const tree = git(["write-tree", "--prefix=.agents/"]);
    if (!tree.success) return;
    const name = `${place.owner}/${place.repo}`;
    writeFile(writtenFile(), { ...readFile(writtenFile()), [name]: tree.stdout.toString().trim() });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Returns what changed in .agents/ from the tree `from` to the tree `to`, as git shows a change,
// each null for no .agents/, so every file shows in full from none. Empty when nothing changed.
// The trees are given, not read again, so what you approve is exactly what you were shown, though
// the daemon moves the clone's default branch meanwhile.
// It must show every byte an agent would read, or you'd approve what you never saw: git shows
// no lines of a file it takes for binary, such as one holding a NUL or marked so in
// .gitattributes, so every file is shown as text, and control codes, which could move the
// cursor over a line or turn text around, are shown as escapes.
export function agentsChange(place: Place, before: string | null, after: string | null): string {
  if (before === after) return "";
  // git names the empty tree by hashing nothing as one, whichever hash the clone uses.
  const empty = gitIn(place, ["hash-object", "-t", "tree", "/dev/null"])?.trim() ?? "";
  const from = before ?? empty;
  const to = after ?? empty;
  // Paths are shown as under .agents/, where you know them from.
  const diff = gitIn(place, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--src-prefix=a/.agents/",
    "--dst-prefix=b/.agents/",
    from,
    to,
  ]);
  if (diff === null) throw new Error("Skelcrew couldn't compare the .agents/ versions");
  return visible(diff);
}

// Returns the text with every control code but newlines and tabs shown as an escape, such as
// \x1b, and every invisible format code, such as one that turns text around, as one such as
// \u202e.
const visible = (text: string) =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => {
    if (c === "\n" || c === "\t") return c;
    const code = c.charCodeAt(0);
    return code < 0x100
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });

// File texts read from trees, by clone, tree and path. A tree never changes, so neither does
// what is read from it, and the screen can ask each second without running git each time.
const read = new Map<string, string | null>();

// Returns the text of a file in a tree of .agents/, such as roles/builder.md, or null when the
// tree has no such plain file. A link is never read, as it could point at any file of yours. A
// tree the clone has lost, such as after the clone was made again, has no files, so its tasks
// fall back on the built-in roles rather than stop.
export function agentsFile(place: Place, tree: string, path: string): string | null {
  const key = `${place.owner}/${place.repo}:${tree}:${path}`;
  if (read.has(key)) return read.get(key) ?? null;
  // ls-tree gives the entry's mode, which tells a plain file from a link. A tree it can't read
  // isn't remembered, as the clone may get it back.
  const listed = gitIn(place, ["ls-tree", tree, path]);
  if (listed === null) return null;
  const entry = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(listed);
  const text = entry?.[2] ? gitIn(place, ["cat-file", "blob", entry[2]]) : null;
  read.set(key, text);
  return text;
}

// Shows what the repository's .agents/ on its default branch holds, or what changed in it since
// the version you approved, and asks whether to approve it. A yes approves it. A no keeps what
// you approved, or the built-in roles, and is saved, so plain sc doesn't ask again. With no
// answer, such as Ctrl-D, nothing is saved. Runs only in your own terminal, as a yes from an
// agent could approve anything. `name` is the repository's name in Skelcrew, for sc repo trust.
export function askAboutAgents(place: Place, name: string): void {
  const fullName = `${place.owner}/${place.repo}`;
  const current = agentsOnDefaultBranch(place);
  const before = approvedAgents(place);
  // Said only when there is something you approved or could approve.
  if (current === before) {
    if (current !== null) console.log(`${fullName}'s .agents/ is the version you approved.`);
    return;
  }
  const what =
    before === null
      ? `${fullName} has its own .agents/, which steers its agents. This is what it holds:`
      : `${fullName}'s .agents/ changed since you approved it:`;
  console.log(`${what}\n\n${agentsChange(place, before, current)}`);
  const answer = prompt(`Approve ${fullName}'s .agents/? [y/N]`)?.trim().toLowerCase();
  if (answer === undefined) return;
  if (["y", "yes"].includes(answer)) {
    approveAgents(place, current);
    console.log(`Approved ${fullName}'s .agents/.`);
    return;
  }
  // A no is saved as what you approved before, so it is remembered as an answer.
  approveAgents(place, before);
  const kept =
    before === null
      ? `Tasks in ${fullName} run on the built-in roles.`
      : `New tasks in ${fullName} keep the version you approved.`;
  console.log(`${kept} To approve it later, run sc repo trust ${name}.`);
}
