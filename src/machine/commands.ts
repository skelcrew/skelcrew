// The setup and test commands sc init writes into a repository's skelcrew.yaml: read from its CI
// workflows and package files, then shown to you to keep or change, so none is a silent guess.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { askLine } from "./pick.ts";

export type Commands = { setup: string[]; test: string[] };

const setupLine =
  /^(bun|npm|pnpm|yarn) (install|ci)\b|^uv sync\b|^poetry install\b|^bundle install\b/;
const testLine = /\b(test|tests|check|lint|typecheck)\b/;

const Workflow = z.looseObject({
  jobs: z
    .record(
      z.string(),
      z.looseObject({ steps: z.array(z.looseObject({ run: z.string().optional() })).optional() }),
    )
    .optional(),
});

function ciLines(root: string): string[] {
  const folder = join(root, ".github", "workflows");
  if (!existsSync(folder)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(folder).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    let workflow: z.infer<typeof Workflow>;
    try {
      workflow = Workflow.parse(parse(readFileSync(join(folder, name), "utf8")));
    } catch {
      continue;
    }
    for (const job of Object.values(workflow.jobs ?? {}))
      for (const step of job.steps ?? [])
        for (const line of (step.run ?? "").split("\n")) if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

function packageCommands(root: string): Partial<Commands> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
  const scripts = z
    .object({ scripts: z.record(z.string(), z.string()).optional() })
    .catch({})
    .parse(data);
  const has = (lock: string) => existsSync(join(root, lock));
  const manager =
    has("bun.lock") || has("bun.lockb")
      ? "bun"
      : has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : "npm";
  const install = manager === "npm" && has("package-lock.json") ? "npm ci" : `${manager} install`;
  const script = ["check", "test"].find((name) => scripts.scripts?.[name] !== undefined);
  return { setup: [install], ...(script ? { test: [`${manager} run ${script}`] } : {}) };
}

export function foundCommands(root: string): Partial<Commands> {
  const lines = ciLines(root);
  const ci = {
    setup: [...new Set(lines.filter((line) => setupLine.test(line)))],
    test: [...new Set(lines.filter((line) => !setupLine.test(line) && testLine.test(line)))],
  };
  const files: Partial<Commands> = existsSync(join(root, "package.json"))
    ? packageCommands(root)
    : existsSync(join(root, "Cargo.toml"))
      ? { test: ["cargo test"] }
      : existsSync(join(root, "go.mod"))
        ? { test: ["go test ./..."] }
        : {};
  const setup = ci.setup.length > 0 ? ci.setup : files.setup;
  const test = ci.test.length > 0 ? ci.test : files.test;
  return { ...(setup ? { setup } : {}), ...(test ? { test } : {}) };
}

export function confirmCommands(root: string, names: (keyof Commands)[]): Partial<Commands> {
  const found = foundCommands(root);
  const ask = (name: "setup" | "test", what: string): string[] => {
    const shown = found[name]?.join(" && ");
    console.log(
      shown
        ? `${what} The repository's CI and package files run: ${shown}`
        : `${what} Skelcrew found none in the repository's CI or package files.`,
    );
    while (true) {
      const answer = askLine(
        shown
          ? `${name}: Enter keeps it, or type other commands joined with &&, or none: `
          : `${name}: type the commands joined with &&, or none: `,
      );
      if (answer === null)
        throw new Error(
          `sc init stopped before you gave the ${name} commands, so it wrote nothing`,
        );
      if (answer === "") {
        if (shown) return found[name] ?? [];
        continue;
      }
      if (answer === "none") return [];
      return answer.split("&&").map((command) => command.trim());
    }
  };
  const what = {
    setup: "Setup runs once in each builder's fresh clone.",
    test: "Test runs the whole test suite.",
  };
  return Object.fromEntries(names.map((name) => [name, ask(name, what[name])]));
}
