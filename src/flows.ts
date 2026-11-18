// The flows: the stages a task goes through and their settings. Skelcrew ships one, `default`,
// in src/defaults/flows/, and a repository can have its own in .agents/flows/, which counts once
// you approved it.
import { parse } from "yaml";
import { z } from "zod";
import { agentsFile, agentsFolder, approvedAgents } from "./approved-agents.ts";
import defaultFlow from "./defaults/flows/default.yaml" with { type: "text" };

// A flow's name, which names its file in .agents/flows/, so it can't hold a slash or start with a
// dot and reach another file.
export const FlowName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "a flow's name is letters, digits, - and _");

// The role a stage runs: its built-in one, or a role of the repository's own, named as its file
// in .agents/roles/ is, so the name can't reach another file either. The lead and the other
// stage's built-in role are refused: the lead belongs to the repository, not a task, and the
// builder's and reviewer's instructions are written for their own stage.
const stageRole = (own: string, other: string) =>
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "a role's name is letters, digits, - and _")
    .refine(
      (role) => role !== "lead" && role !== other,
      `the stage runs ${own} or a role of its own`,
    )
    .optional();

// What a flow file may hold: today's stages, the role each runs, and the round limit. Anything
// else is refused rather than ignored, so a setting put there by mistake doesn't look as if it
// counts.
const Flow = z.strictObject({
  build: z.strictObject({ role: stageRole("builder", "reviewer") }).nullish(),
  review: z
    .strictObject({
      role: stageRole("reviewer", "builder"),
      rounds: z.number().int().positive().optional(),
    })
    .nullish(),
});
type Flow = z.infer<typeof Flow>;

// The built-in default flow's file, byte for byte, which sc init writes out. Bun types a file
// imported as text loosely, so it is checked to be text.
export const builtInFlowText: string = z.string().parse(defaultFlow);

// Reads a flow file's YAML. Throws, naming the problem, when it isn't valid. With
// `withoutRounds`, the review's rounds are left out unread, as your override decides them, so a
// bad one there can't stop a thread while the rest of the flow is still checked.
function readFlow(text: string, withoutRounds = false): Flow {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`the flow isn't valid YAML: ${error instanceof Error ? error.message : error}`);
  }
  if (withoutRounds && isMapping(data) && isMapping(data.review)) {
    const { rounds: _unread, ...review } = data.review;
    data = { ...data, review };
  }
  const flow = Flow.safeParse(data ?? {});
  if (!flow.success) throw new Error(`the flow isn't valid: ${z.prettifyError(flow.error)}`);
  return flow.data;
}

// Returns whether YAML data is a mapping, such as { rounds: 3 }.
const isMapping = (data: unknown): data is Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data);

// Returns how many rounds of changes the built-in default flow gives a task before it needs you.
export function builtInRounds(): number {
  const rounds = readFlow(builtInFlowText).review?.rounds;
  if (rounds === undefined) throw new Error("Skelcrew's built-in flow names no rounds");
  return rounds;
}

// Returns the flows a repository's tasks can run: `default`, which always exists, then each
// flow file of its .agents/ tree, by name. The tree counts as for a role: a task's own, null for
// the built-in files, or without one the version you approved.
export function repositoryFlows(place: {
  owner: string;
  repo: string;
  agents?: string | null;
}): string[] {
  const tree = place.agents === undefined ? approvedAgents(place) : place.agents;
  const files = tree === null ? [] : agentsFolder(place, tree, "flows");
  const named = files.flatMap((file) => {
    const name = file.endsWith(".yaml") ? file.slice(0, -".yaml".length) : "";
    return FlowName.safeParse(name).success && name !== "default" ? [name] : [];
  });
  return ["default", ...named.sort()];
}

// Returns the roles a task's stages run, from its flow's file: the built-in default flow's when
// the flow is `default` and the repository has no file for it. A role other than the built-in
// one must have its file in the same .agents/ tree, or the flow is refused, naming it, rather
// than run a stage on instructions nobody wrote. The rounds are left unread, so a bad one stops
// only what reads the round limit.
export function flowRoles(place: {
  owner: string;
  repo: string;
  agents?: string | null;
  flow?: string;
}): { build: string; review: string } {
  const tree = place.agents === undefined ? approvedAgents(place) : place.agents;
  const flow = place.flow ?? "default";
  const path = `flows/${flow}.yaml`;
  const text = tree === null ? null : agentsFile(place, tree, path);
  if (text === null && flow !== "default")
    throw new Error(`${place.owner}/${place.repo} has no flow ${flow} in its .agents/flows/`);
  const where = `.agents/${path} in ${place.owner}/${place.repo}`;
  let read: Flow;
  try {
    read = readFlow(text ?? builtInFlowText, true);
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : error}`);
  }
  const roles = { build: read.build?.role ?? "builder", review: read.review?.role ?? "reviewer" };
  for (const role of [roles.build, roles.review])
    if (role !== "builder" && role !== "reviewer") {
      const file = tree === null ? null : agentsFile(place, tree, `roles/${role}.md`);
      if (file === null)
        throw new Error(
          `${where}: it names the role ${role}, which has no .agents/roles/${role}.md`,
        );
    }
  return roles;
}

// Returns the round limit a repository's own flow sets, or nothing when the flow is `default`
// with no file of its own, or the file names none. The flow is the task's, `default` when none
// is given. The .agents/ tree counts as for a role: a task's own, null for a task on the
// built-in files, or without one the version you approved. Throws, naming the file, when it
// isn't valid, or when a flow other than `default` has no file there, rather than run a task on
// a flow it doesn't describe. With `withoutRounds`, when your override decides the round limit,
// the file is still checked, as its stages still say which roles run, but its rounds are left
// out and nothing is returned.
export function repositoryRounds(
  place: { owner: string; repo: string; agents?: string | null; flow?: string },
  withoutRounds = false,
): number | undefined {
  const tree = place.agents === undefined ? approvedAgents(place) : place.agents;
  const flow = place.flow ?? "default";
  const path = `flows/${flow}.yaml`;
  const text = tree === null ? null : agentsFile(place, tree, path);
  if (text === null && flow !== "default")
    throw new Error(`${place.owner}/${place.repo} has no flow ${flow} in its .agents/flows/`);
  if (text === null) return undefined;
  try {
    return readFlow(text, withoutRounds).review?.rounds;
  } catch (error) {
    throw new Error(
      `.agents/${path} in ${place.owner}/${place.repo}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
