// The session module is the only way into agents' sessions, so another session host can stand
// in for tmux. These tests read Skelcrew's source and fail when other code reaches the agents'
// tmux server itself.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "src");
// The session module, the only code that may run tmux on the agents' server.
const sessionModule = ["agents/session.ts", "agents/typing.ts"];

// Returns every source file outside the session module and the tmux runner itself, with its
// path inside src and its text.
function otherFiles(): { path: string; text: string }[] {
  const paths = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((path) =>
    path.endsWith(".ts"),
  );
  return paths
    .filter((path) => !sessionModule.includes(path) && path !== "tmux.ts")
    .map((path) => ({ path, text: readFileSync(join(src, path), "utf8") }));
}

test("outside the session module, tmux commands only go to the screen's server", () => {
  // Each call names its server first: the screen's is screenSocket(agents), or a `screen`
  // variable holding it.
  const strays = otherFiles().flatMap(({ path, text }) =>
    [...text.matchAll(/\b(?:mustTmux|tmux)\(\s*([^,]+),/g)]
      .map((call) => call[1] ?? "")
      .filter((server) => server !== "screen" && !server.startsWith("screenSocket("))
      .map((server) => `${path}: tmux(${server}, ...)`),
  );
  expect(strays).toEqual([]);
});

test("outside the session module, only the screen's server is started or attached to", () => {
  // A tmux command line, in an argument list or a shell script, names its server after -L.
  const strays = otherFiles().flatMap(({ path, text }) =>
    text
      .split("\n")
      .filter((line) => /"tmux", "-L"|tmux -L/.test(line) && !line.includes("screenSocket("))
      .map((line) => `${path}: ${line.trim()}`),
  );
  expect(strays).toEqual([]);
});
