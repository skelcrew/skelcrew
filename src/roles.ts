// The roles: what the lead, builders and reviewers are told, and which harness and model they
// run on. Each is a Markdown file, and Skelcrew ships its own in src/defaults/roles/.
import { parse } from "yaml";
import { z } from "zod";
import { HarnessName } from "./agents/harness.ts";
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
  model: z.string().optional(),
});

// A role as its file gives it. The built-in roles name no harness or model, so yours count.
export type Role = z.infer<typeof Frontmatter> & { instructions: string };

// Reads a role file: the frontmatter between two `---` lines, if it has one, and the rest as
// its instructions, kept byte for byte. Throws, naming the problem, when the frontmatter
// isn't valid.
export function readRole(text: string): Role {
  const match = /^---\n([\s\S]*?)^---\n/m.exec(text);
  if (match?.index !== 0) return { instructions: text };
  const front = Frontmatter.safeParse(parse(match[1] ?? "") ?? {});
  if (!front.success)
    throw new Error(`the role's frontmatter isn't valid: ${z.prettifyError(front.error)}`);
  return { ...front.data, instructions: text.slice(match[0].length) };
}

// Returns one of the roles Skelcrew ships, read from its built-in file.
export function builtInRole(name: "lead" | "builder" | "reviewer"): Role {
  return readRole({ lead, builder, reviewer }[name]);
}
