// The roles: what the lead, builders and reviewers are told, and which harness and model they
// run on. Each is a Markdown file. Skelcrew ships its own in src/defaults/roles/, and a
// repository can have its own in .agents/roles/, which count once you approved them.
import { parse } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
import { agentsFile, approvedAgents } from "./approved-agents.ts";
// Bun builds these files into Skelcrew. Each reaches its agent whole, so every line costs
// context: keep them short, and promise only what is built. Without the lead's, told "fix the
// flaky test", the lead would try to edit its read-only clone rather than start a thread. The
// reviewer's tells it to assume the change is wrong, since a reviewer that trusts the builder
// misses what the builder missed. Its {{title}}, {{body}} and {{base}} are blanks the review
// fills in with the task and where the change starts, and {{tests}} with who runs the tests.
import builder from "./defaults/roles/builder.md" with { type: "text" };
import lead from "./defaults/roles/lead.md" with { type: "text" };
import reviewer from "./defaults/roles/reviewer.md" with { type: "text" };

// What a role file's frontmatter may hold. Anything else is refused rather than ignored, so a
// setting put there by mistake doesn't look as if it counts.
const Frontmatter = z.strictObject({
  harness: HarnessName.optional(),
  // An empty model would reach the harness and stop its agent from starting.
  model: z.string().min(1).optional(),
});

// A role as its file gives it. The built-in roles name no harness or model, so yours count.
export type Role = z.infer<typeof Frontmatter> & { instructions: string };

// Reads a role file: the frontmatter between two `---` lines, if it has one, and the rest as
// its instructions, kept byte for byte. Throws, naming the problem, when the frontmatter isn't
// valid, or opens and never closes: read as instructions, it would hand the agent its settings
// as text and run it on a harness and model the file didn't mean.
export function readRole(text: string): Role {
  if (!text.startsWith("---\n")) return { instructions: text };
  const match = /^---\n([\s\S]*?)^---(?:\n|$)/m.exec(text);
  if (match?.index !== 0)
    throw new Error("the role's frontmatter opens with --- and never closes with another ---");
  const front = Frontmatter.safeParse(parse(match[1] ?? "") ?? {});
  if (!front.success)
    throw new Error(`the role's frontmatter isn't valid: ${z.prettifyError(front.error)}`);
  return { ...front.data, instructions: text.slice(match[0].length) };
}

// Returns one of the roles Skelcrew ships, read from its built-in file.
export function builtInRole(name: RoleName): Role {
  return readRole({ lead, builder, reviewer }[name]);
}

// The roles every repository has.
export type RoleName = "lead" | "builder" | "reviewer";

// Returns a role as a repository's agents get it: from its file in the .agents/ tree `agents`
// names, or with none there, the built-in one. A task passes the tree it started with, or null
// when it started on the built-in roles. Without one, the version of .agents/ you approved
// counts, as for the lead and a task starting now. Throws, naming the file, when its frontmatter
// isn't valid, rather than run an agent on a role it doesn't describe.
export function repositoryRole(
  name: RoleName,
  place: { owner: string; repo: string; agents?: string | null },
): Role {
  const tree = place.agents === undefined ? approvedAgents(place) : place.agents;
  const path = `roles/${name}.md`;
  const text = tree === null ? null : agentsFile(place, tree, path);
  if (text === null) return builtInRole(name);
  try {
    return readRole(text);
  } catch (error) {
    throw new Error(
      `.agents/${path} in ${place.owner}/${place.repo}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
