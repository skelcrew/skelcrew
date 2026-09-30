// Which line of a .gitignore leaves out a path, read the way git reads it.
// Init uses it to warn when the files it sets up for Claude Code would
// never be committed. For example, a `.claude/` line leaves out the skill
// links and the approve rules, so teammates who clone wouldn't get them.
//
// It reads only the lines it is given, from the repository's top
// .gitignore. It follows git's rules that matter here, each checked with
// git check-ignore:
//
// - The last line that matches wins. A line starting with ! adds a path
//   back.
// - Git never looks inside a folder that is left out. So `.claude/`
//   followed by `!.claude/settings.json` still leaves out settings.json.
// - A line with no / inside, such as `skills/`, matches that name in any
//   folder. Otherwise it matches from the top of the repository.
// - A line ending in / matches only folders. Git sees a link as a file.

import { basename } from "node:path";
import picomatch from "picomatch";

type Rule = {
  line: string;
  addsBack: boolean;
  foldersOnly: boolean;
  matches: (path: string) => boolean;
};

// The line that leaves out the path, or null when git would see it. Each
// part of the path before the last is a folder. The last is a file or a
// link.
export function leftOutBy(lines: string[], path: string): string | null {
  const rules = lines.flatMap(rule);
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join("/");
    const folder = i < parts.length;
    const last = rules.findLast((one) => (folder || !one.foldersOnly) && one.matches(part));
    if (last !== undefined && !last.addsBack) return last.line;
  }
  return null;
}

function rule(text: string): Rule[] {
  const line = text.trim();
  if (line === "" || line.startsWith("#")) return [];
  const addsBack = line.startsWith("!");
  let pattern = addsBack ? line.slice(1) : line;
  const foldersOnly = pattern.endsWith("/");
  if (foldersOnly) pattern = pattern.slice(0, -1);
  const fromTop = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const options = { dot: true, windows: false };
  const glob = picomatch(pattern, options);
  // In git, `.claude/**` matches what is inside .claude, not .claude
  // itself. picomatch matches both, so the folder itself is left out.
  const itself = pattern.endsWith("/**") ? picomatch(pattern.slice(0, -3), options) : null;
  const matches = (path: string) => {
    const name = fromTop ? path : basename(path);
    return glob(name) && !(itself?.(name) ?? false);
  };
  return [{ line, addsBack, foldersOnly, matches }];
}
