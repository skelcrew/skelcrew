// The crew sc init writes into a repository: the installed harnesses and optional models
// its builders and reviewers run on.
import { readSync, writeSync } from "node:fs";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import type { Role } from "../settings.ts";
import { pick } from "./pick.ts";
import { loginPath } from "./service.ts";

function modelFor(role: string): string | undefined {
  writeSync(1, `${role} model (Enter for the harness default): `);
  const byte = Buffer.alloc(1);
  let model = "";
  while (readSync(0, byte) > 0) {
    const key = byte.toString();
    if (key === "\n" || key === "\r") break;
    if (key === "\x03") process.exit(130);
    model += key;
  }
  return model.trim() || undefined;
}

export function chooseCrew(): { builder: Role; reviewer: Role } {
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
    const model = modelFor(role);
    return model ? { harness: chosen.name, model } : { harness: chosen.name };
  };
  const builder = choose("builders");
  return { builder, reviewer: choose("reviewers", builder.harness) };
}
