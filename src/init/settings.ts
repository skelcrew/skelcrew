// Makes Claude Code ask you before anything runs `skelcrew approve`. The
// spec says this guard lives in the harness's settings, so init adds one
// permission rule to the repository's .claude/settings.json. Claude Code
// checks "ask" rules before "allow" rules, so a broad allow rule elsewhere
// can't skip the question.
//
// Your settings are yours, so init is careful with the file:
//
// - With no file, it writes one holding only the rule.
// - With a file, it adds the rule and keeps everything else. It writes the
//   file back only when that changes nothing but the rule. For example, a
//   file with its lists on one line would come back spread over several
//   lines, so init leaves it alone.
// - Whenever it can't tell what is safe, it changes nothing and warns you
//   with the rule to add by hand.
//
// It never touches .claude/settings.local.json or your own user settings.

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

export const settingsPath = ".claude/settings.json";

// A trailing " *" also matches the bare command, so this covers
// `skelcrew approve` with or without a task number.
export const askRule = "Bash(skelcrew approve *)";

// The older way to write the same rule, which Claude Code still reads.
const sameRules = [askRule, "Bash(skelcrew approve:*)"];

// Whether the rule was added, was there already, or is for you to add.
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
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify({ permissions: { ask: [askRule] } }, null, 2)}\n`, {
      flag: "wx",
    });
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

  if (ask.data.some((rule) => sameRules.includes(rule))) {
    return { askBeforeApprove: "already there", file: "unchanged", warning: null };
  }

  // Write the file back the way it is laid out now: the same indent, and a
  // last newline if it had one. If that doesn't give back the same text,
  // writing it would change more than the rule.
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
    permissions: { ...permissions.data, ask: [...ask.data, askRule] },
  };
  writeFileSync(full, `${JSON.stringify(changed, null, indent)}${end}`);
  return { askBeforeApprove: "added", file: "updated", warning: null };
}

function byHand(why: string): SettingsResult {
  return {
    askBeforeApprove: "add by hand",
    file: "unchanged",
    warning: [
      "Claude Code should ask you before anything runs skelcrew approve.",
      `Init couldn't add that rule, because ${settingsPath} ${why}, so the file was left as it is.`,
      `Add "${askRule}" to the "ask" list under "permissions" in it yourself.`,
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
