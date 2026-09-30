// Makes Claude Code ask you before anything runs `skelcrew approve` or
// `skelcrew reject`. The spec says this guard lives in the harness's
// settings, so init adds permission rules to the repository's
// .claude/settings.json. Reject needs the guard too: an agent that sent a
// task back unasked would write a note the next agent reads as yours. Claude Code
// checks "ask" rules before "allow" rules, so a broad allow rule elsewhere
// can't skip the question.
//
// This guard catches the usual ways of typing the command, not every way.
// Claude Code matches a rule against the command as it is written. So
// `bash -c 'skelcrew approve 12'` or `skelcrew 'approve' 12` runs without
// a question. The Claude Code docs say an ask rule isn't a security
// boundary. That is why the spec calls this guard weaker than approving in
// the TUI. The init report says so too.
//
// Your settings are yours, so init is careful with the file:
//
// - With no file, it writes one holding only the rules.
// - With a file, it adds the rules and keeps everything else. It writes the
//   file back only when that changes nothing but the rules. For example, a
//   file with its lists on one line would come back spread over several
//   lines, so init leaves it alone.
// - Whenever it can't tell what is safe, it changes nothing and warns you
//   with the rules to add by hand.
//
// It never touches .claude/settings.local.json or your own user settings.
// A second run adds nothing. A file with some of the rules gets only the
// ones it lacks.

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

export const settingsPath = ".claude/settings.json";

// One rule for each usual way to run each command. A trailing " *" also
// matches the bare command, so the first four of each cover
// `skelcrew approve` with or without a task number. A leading "*" stands in for any text, so
// the last one covers a path to the program, such as
// `./node_modules/.bin/skelcrew approve 12` or
// `/usr/local/bin/skelcrew approve 12`. With two wildcards the docs say
// the trailing one no longer matches the bare command, so a path with no
// task number isn't caught.
export const askRules = ["approve", "reject"].flatMap((verb) => [
  `Bash(skelcrew ${verb} *)`,
  `Bash(bunx skelcrew ${verb} *)`,
  `Bash(bun x skelcrew ${verb} *)`,
  `Bash(npx skelcrew ${verb} *)`,
  `Bash(*/skelcrew ${verb} *)`,
]);

// What the report tells you about the guard. It says whether the guard is
// in place, and what it can't stop either way.
export function askBeforeApproveLimit(state: AskBeforeApprove): string {
  const inPlace =
    state === "add by hand"
      ? [
          "The guard is not in place yet.",
          "Claude Code won't ask you before anything runs skelcrew approve or skelcrew reject.",
          `To add it, put these in the "ask" list under "permissions" in ${settingsPath}: ${askRules.map((rule) => `"${rule}"`).join(", ")}.`,
          "Then Claude Code will ask before the usual ways of running skelcrew approve or skelcrew reject.",
        ]
      : [
          "Claude Code asks before the usual ways of running skelcrew approve or skelcrew reject, such as `skelcrew approve 12` or `npx skelcrew reject 12 'Add totals.'`.",
        ];
  return [
    ...inPlace,
    "It is not a lock. A command written another way, such as `bash -c 'skelcrew approve 12'`, runs without asking.",
    "So this guard is weaker than approving in the TUI.",
    "These rules work only in Claude Code.",
    "So does the setting that lets only you start the spec, develop, approve and reject skills.",
    "In another harness, set up its own guard, or approve only by typing skelcrew approve yourself.",
  ].join(" ");
}

// Whether the list has the rule, written either way Claude Code reads:
// "Bash(x *)" or the older "Bash(x:*)".
function hasRule(list: string[], rule: string): boolean {
  return list.includes(rule) || list.includes(rule.replace(/ \*\)$/, ":*)"));
}

// Whether the rules were added, were there already, or are for you to add.
export type AskBeforeApprove = "added" | "already there" | "add by hand";

export type SettingsResult = {
  askBeforeApprove: AskBeforeApprove;
  file: "created" | "updated" | "unchanged";
  warning: string | null;
};

const jsonObject = z.record(z.string(), z.unknown());
const ruleList = z.array(z.string());

export function addAskRule(dir: string): SettingsResult {
  const full = join(dir, settingsPath);

  const kind = fileKind(full);
  if (kind === "missing") {
    const text = `${JSON.stringify({ permissions: { ask: askRules } }, null, 2)}\n`;
    const failed = write(full, text, "wx");
    if (failed !== null) return byHand(`can't be created: ${failed}`);
    return { askBeforeApprove: "added", file: "created", warning: null };
  }
  if (kind === "link") return byHand("is a link to another file");
  if (kind !== "file") return byHand("isn't a file init can read");

  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return byHand("can't be read");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return byHand("isn't valid JSON");
  }

  const top = jsonObject.safeParse(data);
  if (!top.success) return byHand("doesn't hold a JSON object");
  const permissions = jsonObject.safeParse(top.data.permissions ?? {});
  if (!permissions.success) return byHand("has a permissions entry that isn't an object");
  const ask = ruleList.safeParse(permissions.data.ask ?? []);
  if (!ask.success) return byHand("has an ask entry that isn't a list of rules");

  const missing = askRules.filter((rule) => !hasRule(ask.data, rule));
  if (missing.length === 0) {
    return { askBeforeApprove: "already there", file: "unchanged", warning: null };
  }

  // Write the file back the way it is laid out now: the same indent, and a
  // last newline if it had one. If that doesn't give back the same text,
  // writing it would change more than the rules.
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  const end = text.endsWith("\n") ? "\n" : "";
  if (`${JSON.stringify(data, null, indent)}${end}` !== text) {
    return byHand("would change its layout if init wrote it back");
  }

  // The checked copy must hold exactly what the file does. A key JSON
  // allows but JavaScript treats specially, such as "__proto__", would be
  // lost from it, and writing it back would drop that key.
  const same = (copy: unknown, original: unknown) =>
    JSON.stringify(copy) === JSON.stringify(original);
  if (!same(top.data, data) || !same(permissions.data, top.data.permissions ?? {})) {
    return byHand("has something init can't write back exactly");
  }

  const changed = {
    ...top.data,
    permissions: { ...permissions.data, ask: [...ask.data, ...missing] },
  };
  const failed = write(full, `${JSON.stringify(changed, null, indent)}${end}`, "w");
  if (failed !== null) return byHand(`can't be written: ${failed}`);
  return { askBeforeApprove: "added", file: "updated", warning: null };
}

// Writes the file, making its folder first if needed. Returns why it
// failed, in plain words where it can, or null when it worked. The "wx" flag refuses a file that is already
// there, so a new file never overwrites one that appeared meanwhile.
function write(path: string, text: string, flag: "w" | "wx"): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag });
    return null;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return "init isn't allowed to write there";
    }
    return error instanceof Error ? error.message : String(error);
  }
}

function byHand(why: string): SettingsResult {
  return {
    askBeforeApprove: "add by hand",
    file: "unchanged",
    warning: [
      "Claude Code should ask you before anything runs skelcrew approve or skelcrew reject.",
      `Init couldn't add the rules for that, because ${settingsPath} ${why}, so the file was left as it is.`,
      `Add these to the "ask" list under "permissions" in it yourself: ${askRules.map((rule) => `"${rule}"`).join(", ")}.`,
    ].join(" "),
  };
}

// What is at the path, without following a link.
function fileKind(path: string): "missing" | "file" | "link" | "other" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "link";
    return stat.isFile() ? "file" : "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    return "other";
  }
}
