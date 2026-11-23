// The crew sc init writes into a repository: the installed harnesses its lead, builders and
// reviewers run on.
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import type { RoleName } from "../roles.ts";
import type { Role } from "../settings.ts";
import { pick } from "./pick.ts";
import { loginPath } from "./service.ts";

export function chooseCrew(names: RoleName[]): Partial<Record<RoleName, Role>> {
  const PATH = loginPath();
  const installed = HarnessName.options
    .map(harnessNamed)
    .filter((h) => Bun.which(h.program, { PATH }));
  if (installed.length === 0)
    throw new Error(
      "sc init needs an installed coding agent: install Claude Code, Codex or Pi first",
    );
  const titles = { lead: "the lead", builder: "builders", reviewer: "reviewers" };
  const [only] = installed;
  if (only && installed.length === 1) {
    const roles = names.map((name) => titles[name]);
    const listed =
      roles.length > 1 ? `${roles.slice(0, -1).join(", ")} and ${roles.at(-1)}` : roles.join("");
    console.log(
      `${only.title} is the only coding agent installed, so Skelcrew puts ${listed} on it.`,
    );
  }
  const crew: Partial<Record<RoleName, Role>> = {};
  for (const name of names) {
    const role = titles[name];
    const at =
      installed.length === 1
        ? 0
        : pick(
            `Choose the coding agent for ${role}:`,
            installed.map((h) => ({ label: h.title, hint: "installed" })),
          );
    const chosen = at === null ? undefined : installed[at];
    if (!chosen) throw new Error(`no harness was picked for ${role}, so none is saved`);
    crew[name] = { harness: chosen.name };
  }
  return crew;
}
