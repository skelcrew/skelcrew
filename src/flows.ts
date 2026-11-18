// The flows: the stages a task goes through and their settings. Skelcrew ships one, `default`,
// in src/defaults/flows/, and a repository can have its own in .agents/flows/, which counts once
// you approved it.
import { parse } from "yaml";
import { z } from "zod";
import { agentsFile, agentsFolder, approvedAgents } from "./approved-agents.ts";
import defaultFlow from "./defaults/flows/default.yaml" with { type: "text" };

// What a flow file may hold: today's stages and their one setting, the round limit. Anything
// else is refused rather than ignored, so a setting put there by mistake doesn't look as if it
// counts. Each stage runs today's role, so a flow may name only that one: a builder stage on
// the reviewer, or a role with no agents behind it, would otherwise read as if it counted.
const Flow = z.strictObject({
  build: z.strictObject({ role: z.literal("builder").optional() }).nullish(),
  review: z
    .strictObject({
      role: z.literal("reviewer").optional(),
      rounds: z.number().int().positive().optional(),
    })
    .nullish(),
});
type Flow = z.infer<typeof Flow>;

// A flow's name, which names its file in .agents/flows/, so it can't hold a slash or start with a
// dot and reach another file.
export const FlowName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "a flow's name is letters, digits, - and _");

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

// Throws unless the repository's tasks can run `flow`, saying which flows they can, for sc start.
// `name` is the repository's name in Skelcrew, and the tree counts as for repositoryFlows.
export function checkFlow(
  place: { owner: string; repo: string; agents?: string | null },
  name: string,
  flow: string,
): void {
  const flows = repositoryFlows(place);
  if (!flows.includes(flow))
    throw new Error(`${name} has no flow ${flow}. Its flows are ${flows.join(", ")}.`);
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
