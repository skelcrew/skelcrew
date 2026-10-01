// Ink and React take about 100 ms to load, and agents run the CLI often.
// So only bare `skelcrew` loads them, and only once it opens the screen.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const transpiler = new Bun.Transpiler({ loader: "tsx" });

// The packages a file loads as it starts, through the repository's own
// files too. What it loads later, with import(), is left out.
function packagesLoadedBy(file: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path) || !/\.tsx?$/.test(path)) return;
    seen.add(path);
    // The scanner can't read the #! line that starts main.ts.
    const code = readFileSync(path, "utf8").replace(/^#!.*/, "");
    for (const { path: name, kind } of transpiler.scanImports(code)) {
      if (kind === "dynamic-import") continue;
      if (name.startsWith(".")) visit(Bun.resolveSync(name, dirname(path)));
      else packages.add(name);
    }
  };
  visit(file);
  return packages;
}

const src = join(import.meta.dir, "..");

test("the skelcrew program doesn't load Ink or React as it starts", () => {
  const packages = [...packagesLoadedBy(join(src, "cli", "main.ts"))];
  expect(packages.filter((name) => /^(ink|react)(\/|$)/.test(name))).toEqual([]);
});

// Without this, the test above would pass for a walk that finds nothing.
test("the screen does load Ink", () => {
  expect(packagesLoadedBy(join(src, "tui", "open.tsx")).has("ink")).toBe(true);
});
