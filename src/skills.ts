// A repository's skills: the folders of .agents/skills/ you approved, copied into a folder of one
// session's own as it starts, or listed in its instructions for a harness that reads no folder.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { cloneDir } from "./paths.ts";

// Where a session's skills come from: the repository, and the tree of .agents/ its agents run on,
// the one you approved or the one its task started with. null is the built-in files, which hold
// no skills.
export type SkillsFrom = { owner: string; repo: string; agents: string | null };

// A skill as an agent is told of it: its name and description from its SKILL.md, and where that
// file is.
export type Skill = { name: string; description: string; file: string };

// What a SKILL.md's frontmatter says of the skill. Anything else in it is the harness's to read.
const Frontmatter = z.looseObject({ name: z.string(), description: z.string() }).partial();

// Replaces the folder `into` with the skills of the .agents/ tree `from` names, and returns each
// skill copied. Whatever was there goes first, so an agent that changed its copy, or a skill the
// repository has since dropped, never lasts into the next start. Only plain files are copied: a
// link could point at any file of yours. Throws when Skelcrew's clone has lost the tree, as the
// session's roles do.
export function copySkills(from: SkillsFrom, into: string): Skill[] {
  // A link the agent left at `into` is removed, never followed.
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true, mode: 0o700 });
  if (from.agents === null) return [];
  const clone = cloneDir(from.owner, from.repo);
  const git = (args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "pipe" });
    if (!run.success)
      throw new Error(
        `Skelcrew couldn't read the skills of ${from.owner}/${from.repo}'s .agents/ version ${from.agents?.slice(0, 7)}: ${run.stderr.toString().trim()}`,
      );
    return run.stdout;
  };
  // Every file under skills/, with its mode, which tells a plain file from a link.
  const listed = git(["ls-tree", "-r", "-z", from.agents, "skills/"]).toString().split("\0");
  const skills: Skill[] = [];
  for (const line of listed) {
    const entry = /^(100644|100755) blob ([0-9a-f]+)\tskills\/(.+)$/.exec(line);
    if (!entry?.[2] || !entry[3]) continue;
    const [, mode, blob, path] = entry;
    const file = join(into, path);
    mkdirSync(dirname(file), { recursive: true });
    // Read as bytes, so a skill's images or scripts arrive whole.
    writeFileSync(file, git(["cat-file", "blob", blob]), { flag: "wx" });
    chmodSync(file, mode === "100755" ? 0o755 : 0o644);
    // A skill is a folder directly under skills/ with a SKILL.md.
    const skill = /^([^/]+)\/SKILL\.md$/.exec(path)?.[1];
    if (skill) skills.push({ ...describe(file, skill), file });
  }
  return skills;
}

// Returns a skill's name and description from its SKILL.md's frontmatter, or its folder's name
// and no description when the frontmatter doesn't say. A skill written badly is still listed, so
// the agent can read it.
function describe(file: string, folder: string): { name: string; description: string } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(readFileSync(file, "utf8"))?.[1];
  let said: z.infer<typeof Frontmatter> = {};
  try {
    said = Frontmatter.safeParse(parse(front ?? "")).data ?? {};
  } catch {
    // Frontmatter that isn't YAML says nothing.
  }
  return { name: said.name?.trim() || folder, description: said.description?.trim() ?? "" };
}

// Returns the lines that tell an agent of its skills, for a harness that reads no folder of
// them: one per skill, with its name, description and the path of its SKILL.md. Empty with none.
export function skillsTold(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (skill) =>
      `- ${skill.name}, in ${skill.file}${skill.description ? `: ${skill.description}` : ""}`,
  );
  return `The repository gives you skills: knowledge you load when you need it. When one fits your work, read its SKILL.md, and any files it points to beside it.\n${lines.join("\n")}`;
}

// Returns the SKILL.md files a reviewer's harness must leave unloaded, as paths from the top of
// the repository: those under .agents/skills/ in the submitted commit, read from Skelcrew's
// clone `clone`, which has every submitted commit, and those on disk now in the builder's clone
// `builderClone`, where the builder could have left one git ignores. The builder's git is never
// run, as its settings are its own. A commit with a link in .agents/ is checked out into a
// folder of its own first, so the skills its links reach are found as Codex would find them.
// Throws when git can't read the commit, so the review fails rather than run with the branch's
// skills.
export function branchSkills(clone: string, commit: string, builderClone: string): string[] {
  const git = (args: string[], env?: Record<string, string>) => {
    const run = Bun.spawnSync(["git", ...args], {
      ...(env ? { env: { ...process.env, ...env } } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!run.success)
      throw new Error(
        `Skelcrew couldn't read the skills of ${commit.slice(0, 7)}: ${run.stderr.toString().trim()}`,
      );
    return run.stdout.toString();
  };
  const entries = git(["-C", clone, "ls-tree", "-r", "-z", commit, "--", ".agents"]).split("\0");
  const fromRoot = (root: string) => {
    const top = realpathSync(root);
    return checkoutSkills(root).flatMap((file) =>
      file.startsWith(top + sep) ? [relative(top, file)] : [],
    );
  };
  let committed: string[];
  if (entries.some((line) => line.startsWith("120000 "))) {
    const folder = mkdtempSync(join(tmpdir(), "skelcrew-skills-"));
    try {
      const tree = join(folder, "tree");
      mkdirSync(tree);
      git(
        [
          "--git-dir",
          join(clone, ".git"),
          "--work-tree",
          tree,
          "read-tree",
          "--reset",
          "-u",
          commit,
        ],
        {
          GIT_INDEX_FILE: join(folder, "index"),
        },
      );
      committed = fromRoot(tree);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  } else
    committed = entries.flatMap((line) => {
      const path = /^(?:100644|100755) blob [0-9a-f]+\t(\.agents\/skills\/.+\/SKILL\.md)$/.exec(
        line,
      )?.[1];
      return path ? [path] : [];
    });
  return [...new Set([...committed, ...fromRoot(builderClone)])];
}

// Returns every SKILL.md in the .agents/skills/ of the checkout at `root`, as it is on disk now,
// for a Codex builder to leave unloaded: Codex loads the skills it finds there on its own, and
// those are the default branch's or the builder's, not the ones you approved. Links are followed,
// as Codex follows them, and each file is given both as found and as its real path, since either
// could be how Codex names it. Only folders inside the checkout are walked, as the sandbox shows
// nothing else.
export function checkoutSkills(root: string): string[] {
  const top = realpathSync(root);
  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if ((real !== top && !real.startsWith(top + sep)) || seen.has(real)) return;
    seen.add(real);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(path);
      else if (stat?.isFile() && name === "SKILL.md") {
        found.add(path);
        found.add(realpathSync(path));
      }
    }
  };
  walk(join(root, ".agents", "skills"));
  return [...found];
}
