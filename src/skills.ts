// A repository's skills: the folders of .agents/skills/ you approved, copied into a folder of one
// session's own as it starts, or listed in its instructions for a harness that reads no folder.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// Returns the SKILL.md files the commit has under .agents/skills/, at any depth, as paths from
// the top of the repository, for the reviewer's harness to leave unloaded. Read from Skelcrew's
// clone, which has every submitted commit, never the builder's, whose git settings are its own.
// Links are left out: the review's view drops them. Throws when git can't read the commit, so the
// review fails rather than run with the branch's skills.
export function branchSkills(clone: string, commit: string): string[] {
  const run = Bun.spawnSync(
    ["git", "-C", clone, "ls-tree", "-r", "-z", commit, "--", ".agents/skills/"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!run.success)
    throw new Error(
      `Skelcrew couldn't read the skills of ${commit.slice(0, 7)}: ${run.stderr.toString().trim()}`,
    );
  return run.stdout
    .toString()
    .split("\0")
    .flatMap((line) => {
      const path = /^(?:100644|100755) blob [0-9a-f]+\t(.+\/SKILL\.md)$/.exec(line)?.[1];
      return path ? [path] : [];
    });
}
