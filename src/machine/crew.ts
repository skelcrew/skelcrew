// The crew sc init writes into a repository: the installed harnesses and optional models
// its lead, builders and reviewers run on.
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import type { RoleName } from "../roles.ts";
import type { Role } from "../settings.ts";
import { askLine, pick } from "./pick.ts";
import { loginPath } from "./service.ts";

export function chooseCrew(
  names: RoleName[],
  builderOn?: HarnessName,
): Partial<Record<RoleName, Role>> {
  const PATH = loginPath();
  const installed = HarnessName.options
    .map(harnessNamed)
    .filter((h) => Bun.which(h.program, { PATH }));
  if (installed.length === 0)
    throw new Error(
      "sc init needs an installed coding agent: install Claude Code, Codex or Pi first",
    );
  const choose = (role: string, other?: HarnessName): Role => {
    const choices = [
      ...installed.filter((h) => h.name !== other),
      ...installed.filter((h) => h.name === other),
    ];
    const at =
      choices.length === 1
        ? 0
        : pick(
            `Choose the coding agent for ${role}:`,
            choices.map((h) => ({
              label: h.title,
              hint: h.name !== other && other ? "installed · a second opinion" : "installed",
            })),
          );
    const chosen = at === null ? undefined : choices[at];
    if (!chosen) throw new Error(`no harness was picked for ${role}, so none is saved`);
    const model = askLine(`${role} model (Enter for the harness default): `) || undefined;
    return model ? { harness: chosen.name, model } : { harness: chosen.name };
  };
  const titles = { lead: "the lead", builder: "builders", reviewer: "reviewers" };
  const crew: Partial<Record<RoleName, Role>> = {};
  for (const name of names)
    crew[name] = choose(
      titles[name],
      name === "reviewer" ? (crew.builder?.harness ?? builderOn) : undefined,
    );
  return crew;
}
