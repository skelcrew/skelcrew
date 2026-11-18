// The flows: the stages a task goes through and their settings. Skelcrew ships one, `default`,
// in src/defaults/flows/, and a repository can have its own in .agents/flows/, which counts once
// you approved it.
import { parse } from "yaml";
import { z } from "zod";
import { agentsFile, approvedAgents } from "./approved-agents.ts";
import defaultFlow from "./defaults/flows/default.yaml" with { type: "text" };

// What a flow file may hold: today's stages and their one setting, the round limit. Anything
// else is refused rather than ignored, so a setting put there by mistake doesn't look as if it
// counts.
const Flow = z.strictObject({
  build: z.strictObject({ role: z.string().min(1).optional() }).nullish(),
  review: z
    .strictObject({
      role: z.string().min(1).optional(),
      rounds: z.number().int().positive().optional(),
    })
    .nullish(),
});
type Flow = z.infer<typeof Flow>;

// The built-in default flow's file, byte for byte, which sc init writes out. Bun types a file
// imported as text loosely, so it is checked to be text.
export const builtInFlowText: string = z.string().parse(defaultFlow);

// Reads a flow file's YAML. Throws, naming the problem, when it isn't valid.
function readFlow(text: string): Flow {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`the flow isn't valid YAML: ${error instanceof Error ? error.message : error}`);
  }
  const flow = Flow.safeParse(data ?? {});
  if (!flow.success) throw new Error(`the flow isn't valid: ${z.prettifyError(flow.error)}`);
  return flow.data;
}

// Returns how many rounds of changes the built-in default flow gives a task before it needs you.
export function builtInRounds(): number {
  const rounds = readFlow(builtInFlowText).review?.rounds;
  if (rounds === undefined) throw new Error("Skelcrew's built-in flow names no rounds");
  return rounds;
}

// Returns the round limit a repository's own default flow sets, or nothing when it has no flow
// file or the file names none. The .agents/ tree counts as for a role: a task's own, null for a
// task on the built-in files, or without one the version you approved. Throws, naming the file,
// when it isn't valid, rather than run a task on a flow it doesn't describe.
export function repositoryRounds(place: {
  owner: string;
  repo: string;
  agents?: string | null;
}): number | undefined {
  const tree = place.agents === undefined ? approvedAgents(place) : place.agents;
  const path = "flows/default.yaml";
  const text = tree === null ? null : agentsFile(place, tree, path);
  if (text === null) return undefined;
  try {
    return readFlow(text).review?.rounds;
  } catch (error) {
    throw new Error(
      `.agents/${path} in ${place.owner}/${place.repo}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
