// Trust for a repository's .agents/: the version of it you approved, for each repository, and
// reading its files. Its role instructions decide what agents are told, so only a version you
// approved ever steers them, and a change to it waits until you approve that too.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Returns every repository's approval, checked, or none before you approved anything.
function readApprovals(): Record<string, string> {
  const file = approvalsFile();
  if (!existsSync(file)) return {};
  const read = Approvals.safeParse(parse(readFileSync(file, "utf8")) ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return read.data;
}

// Saves every repository's approval.
function writeApprovals(approvals: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(approvalsFile(), Object.keys(approvals).length ? stringify(approvals) : "");
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
export function approveAgents(place: Place, tree: string | null): void {
  if (tree !== null && gitIn(place, ["update-ref", `refs/skelcrew/agents/${tree}`, tree]) === null)
    throw new Error(`Skelcrew's clone of ${place.owner}/${place.repo} has no tree ${tree}`);
  writeApprovals({ ...readApprovals(), [`${place.owner}/${place.repo}`]: tree ?? "none" });
  markApproved(place);
}

// Returns the git tree of the .agents/ folder that committing in the checkout at `checkout` would
// bring, for sc init, so it can be approved or asked about before it reaches the default branch,
// or null when a commit would hold none of it, as when git ignores it all. That is what the
// checkout has staged, as a commit takes it, and new files git doesn't ignore, as sc init asks you
// to commit the files it wrote. It is read through a copy of the checkout's index, so the index
// itself never changes, and the tree and its files are then copied into Skelcrew's clone, which
// approving needs. Throws when git can't read them.
export function checkoutAgents(place: Place, checkout: string): string | null {
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-agents-"));
  const index = join(folder, "index");
  // Runs git in `repo`, the checkout unless named, on the copy of its index, with `stdin` if
  // given, and returns what it printed. Throws, naming what failed, when git does.
  const git = (args: string[], given: { repo?: string; stdin?: Uint8Array | string } = {}) => {
    const run = Bun.spawnSync(["git", "-C", given.repo ?? checkout, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: index },
      ...(given.stdin === undefined ? {} : { stdin: new Blob([given.stdin]) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!run.success)
      throw new Error(
        `Skelcrew couldn't read ${checkout}'s .agents/: ${run.stderr.toString().trim()}`,
      );
    return run.stdout;
  };
  try {
    // Start from what the checkout has staged. A checkout with nothing staged yet has no index.
    const staged = Bun.spawnSync(
      ["git", "-C", checkout, "rev-parse", "--path-format=absolute", "--git-path", "index"],
      { stdout: "pipe", stderr: "pipe" },
    )
      .stdout.toString()
      .trim();
    if (staged && existsSync(staged)) copyFileSync(staged, index);
    // Add the new files git doesn't ignore, given on stdin, as there can be more than a command
    // line holds. The checkout's own ignore rules say which.
    const untracked = Bun.spawnSync(
      ["git", "-C", checkout, "ls-files", "-z", "--others", "--exclude-standard", "--", ".agents"],
      { stdout: "pipe", stderr: "pipe" },
    ).stdout.toString();
    if (untracked)
      git(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { stdin: untracked });
    if (git(["ls-files", "-z", "--", ".agents"]).length === 0) return null;
    const tree = git(["write-tree", "--prefix=.agents/"]).toString().trim();
    // Copy the tree and its files into Skelcrew's clone, as a pack, which unpack-objects takes
    // in one go.
    const objects = git(["rev-list", "--objects", tree]);
    const pack = git(["pack-objects", "-q", "--stdout"], { stdin: objects });
    git(["unpack-objects", "-q"], { repo: cloneDir(place.owner, place.repo), stdin: pack });
    return tree;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The ref in Skelcrew's clone at the .agents/ you approved, where the lead reads the flows it
// triages with. Its sandbox shows it the clone read-only, so it can't change what it reads, and
// what it reads is what tasks run, not a change on the default branch you haven't approved.
// Without the ref, you approved the built-in files.
export const approvedRef = "refs/skelcrew/agents/approved";

// Points approvedRef at the .agents/ you approved for the repository, or removes it for the
// built-in files. It costs one git call when it already does, so the daemon runs it at each
// poll, which also gives the ref to a repository approved before it existed.
export function markApproved(place: Place): void {
  const tree = approvedAgents(place);
  const now = gitIn(place, ["rev-parse", "--verify", "--quiet", approvedRef])?.trim() || null;
  if (now === tree) return;
  gitIn(
    place,
    tree === null ? ["update-ref", "-d", approvedRef] : ["update-ref", approvedRef, tree],
  );
}

// Forgets what you approved for the repository, for sc repo rm, so adding it again asks again.
export function forgetAgents(place: Place): void {
  if (!agentsAnswered(place)) return;
  const { [`${place.owner}/${place.repo}`]: _gone, ...rest } = readApprovals();
  writeApprovals(rest);
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

// Returns the text of a file in a tree of .agents/, such as roles/builder.md, or null when the
// tree has no such plain file. A link is never read, as it could point at any file of yours.
// Throws when the clone has lost the tree, such as after the clone was made again from a history
// without it: falling back on the built-in roles would run a task on instructions other than the
// ones it started with, or the lead on ones you didn't approve. Its agents stop until the clone
// has the tree again, or you approve another version with sc repo trust.
export function agentsFile(place: Place, tree: string, path: string): string | null {
  // Read from git each time, never kept, so a version the clone has lost since stops its agents
  // at once. ls-tree gives the entry's mode, which tells a plain file from a link.
  const listed = gitIn(place, ["ls-tree", tree, path]);
  if (listed === null)
    throw new Error(
      `Skelcrew's clone of ${place.owner}/${place.repo} no longer has the .agents/ version ${tree.slice(0, 7)}, so its agents won't start on other instructions. Run sc repo trust ${place.repo} to approve the version it has now.`,
    );
  const entry = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(listed);
  return entry?.[2] ? gitIn(place, ["cat-file", "blob", entry[2]]) : null;
}

// Returns the names of the plain files directly in a folder of a tree of .agents/, such as
// flows, or none when it has no such folder. Links are left out, as agentsFile never reads them.
export function agentsFolder(place: Place, tree: string, folder: string): string[] {
  const listed = gitIn(place, ["ls-tree", "-z", tree, `${folder}/`]) ?? "";
  return listed.split("\0").flatMap((line) => {
    const entry = /^(?:100644|100755) blob [0-9a-f]+\t(.+)$/.exec(line);
    return entry?.[1] ? [entry[1].slice(folder.length + 1)] : [];
  });
}

// Shows what the repository's .agents/ on its default branch holds, or what changed in it since
// the version you approved, and asks whether to approve it. sc init passes `current`, the tree of
// the .agents/ in your checkout, to ask about that one instead. A yes approves it. A no keeps what
// you approved, or the built-in roles, and is saved, so plain sc doesn't ask again. With no
// answer, such as Ctrl-D, nothing is saved. Runs only in your own terminal, as a yes from an
// agent could approve anything. `name` is the repository's name in Skelcrew, for sc repo trust.
export function askAboutAgents(
  place: Place,
  name: string,
  current = agentsOnDefaultBranch(place),
): void {
  const fullName = `${place.owner}/${place.repo}`;
  const before = approvedAgents(place);
  // Said only when there is something you approved or could approve.
  if (current === before) {
    if (current !== null) console.log(`${fullName}'s .agents/ is the version you approved.`);
    return;
  }
  // A version the clone lost can't be compared with, so the whole of .agents/ is shown.
  const lost = before !== null && gitIn(place, ["cat-file", "-e", `${before}^{tree}`]) === null;
  const what =
    before === null
      ? `${fullName} has its own .agents/, which steers its agents. This is what it holds:`
      : lost
        ? `Skelcrew's clone of ${fullName} no longer has the version you approved, so its agents are stopped. This is what its .agents/ holds now:`
        : `${fullName}'s .agents/ changed since you approved it:`;
  console.log(`${what}\n\n${agentsChange(place, lost ? null : before, current)}`);
  const answer = prompt(`Approve ${fullName}'s .agents/? [y/N]`)?.trim().toLowerCase();
  if (answer === undefined) return;
  if (["y", "yes"].includes(answer)) {
    approveAgents(place, current);
    console.log(`Approved ${fullName}'s .agents/.`);
    return;
  }
  // A no is saved as what you approved before, so it is remembered as an answer. A lost version
  // stays as it was saved, as the clone has nothing left to keep.
  if (!lost) approveAgents(place, before);
  const kept =
    before === null
      ? `Tasks in ${fullName} run on the built-in roles.`
      : `New tasks in ${fullName} keep the version you approved.`;
  console.log(`${kept} To approve it later, run sc repo trust ${name}.`);
}
