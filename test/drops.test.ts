// Files dropped onto the screen: a paste of their paths is rewritten to copies in the agent's
// folder, and every other paste and key passes through as it came.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDrops, dropsFolder, largestDrop, pasteFilter } from "../src/screen/drops.ts";

let home = "";
let agent = "";
let sent = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-drops-test-")));
  agent = join(home, "agent");
  mkdirSync(agent);
  mkdirSync(join(home, "Screen Shots"));
  sent = "";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// A filter that copies into the agent's folder and keeps what it sends on.
const filter = () =>
  pasteFilter(
    (bytes) => {
      sent += Buffer.from(bytes).toString();
    },
    async (files) => copyDrops(agent, files),
  );

// Makes a file in the test's home and returns its path.
function file(name: string, text = `the text of ${name}`): string {
  const path = join(home, name);
  writeFileSync(path, text);
  return path;
}

// Returns what reached the agent once the filter has had time to copy.
async function afterCopies(): Promise<string> {
  await Bun.sleep(50);
  return sent;
}

const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`;

// The copies in the agent's folder, by the path the paste gave.
const copies = (text: string) =>
  [
    ...text
      .replaceAll("\x1b[200~", " ")
      .replaceAll("\x1b[201~", " ")
      .matchAll(/(?:\\ |[^\s'])+/g),
  ]
    .map((found) => found[0].replaceAll("\\ ", " "))
    .filter((path) => path.startsWith(`${agent}/${dropsFolder}/`));

test("one dropped file's path becomes its copy's, in the agent's folder", async () => {
  const shot = file("shot.png");
  filter()(Buffer.from(pasted(shot)));
  const out = await afterCopies();
  expect(out).toMatch(
    new RegExp(`^\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~$`),
  );
  const [copy = ""] = copies(out);
  expect(readFileSync(copy, "utf8")).toBe("the text of shot.png");
  // Git never sees the copies, so a builder doesn't commit them.
  expect(readFileSync(join(agent, dropsFolder, ".gitignore"), "utf8")).toBe("*\n");
});

test("several dropped files are each copied, with the spaces between them kept", async () => {
  const one = file("one.png");
  const two = file("two.pdf");
  filter()(Buffer.from(pasted(`${one} ${two}\n`)));
  const out = await afterCopies();
  const [first = "", second = ""] = copies(out);
  expect(out).toBe(pasted(`${first} ${second}\n`));
  expect(readFileSync(first, "utf8")).toBe("the text of one.png");
  expect(readFileSync(second, "utf8")).toBe("the text of two.pdf");
});

test("a path with spaces is rewritten escaped as it came, or in its quotes", async () => {
  const shot = file("Screen Shots/Screen Shot 1.png");
  const escaped = shot.replaceAll(" ", "\\ ");
  filter()(Buffer.from(pasted(escaped)));
  const out = await afterCopies();
  expect(out.endsWith("/Screen\\ Shot\\ 1.png\x1b[201~")).toBe(true);
  expect(out).not.toContain("Screen\\ Shots");
  const [copy = ""] = copies(out);
  expect(readFileSync(copy, "utf8")).toBe("the text of Screen Shots/Screen Shot 1.png");

  sent = "";
  filter()(Buffer.from(pasted(`'${shot}'`)));
  const quoted = await afterCopies();
  expect(quoted).toMatch(
    new RegExp(`^\\x1b\\[200~'${agent}/${dropsFolder}/[^/]+/Screen Shot 1\\.png'\\x1b\\[201~$`),
  );
});

test("a text paste passes as it came, at once", () => {
  const take = filter();
  take(Buffer.from(pasted("hello /tmp and the rest")));
  expect(sent).toBe(pasted("hello /tmp and the rest"));
  expect(existsSync(join(agent, dropsFolder))).toBe(false);
});

test("keys pass at once, an Esc on its own too", () => {
  const take = filter();
  take(Buffer.from("a"));
  take(Buffer.from("\x1b"));
  take(Buffer.from("\x1b[13;2u\x1b[<0;3;4M"));
  expect(sent).toBe("a\x1b\x1b[13;2u\x1b[<0;3;4M");
});

test("a missing path, a folder, a file you can't read and one too big keep their paths", async () => {
  const unreadable = file("secret.txt");
  chmodSync(unreadable, 0);
  const big = file("big.bin", "");
  // A sparse file is as big as it says, without filling the disk.
  Bun.spawnSync(["truncate", "-s", String(largestDrop + 1), big]);
  const shot = file("shot.png");
  const kept = `${join(home, "gone.png")} ${join(home, "Screen Shots")} ${big}`;
  const take = filter();
  take(Buffer.from(pasted(kept)));
  expect(await afterCopies()).toBe(pasted(kept));
  // Run as root, the file can still be read, so it is only checked where it can't be.
  if (process.getuid?.() !== 0) {
    sent = "";
    take(Buffer.from(pasted(unreadable)));
    expect(await afterCopies()).toBe(pasted(unreadable));
  }
  // Mixed with a file that can be copied, only that one changes.
  sent = "";
  take(Buffer.from(pasted(`${join(home, "gone.png")} ${shot}`)));
  const out = await afterCopies();
  expect(out.startsWith(`\x1b[200~${join(home, "gone.png")} ${agent}/`)).toBe(true);
  expect(
    readdirSync(join(agent, dropsFolder)).filter((name) => name !== ".gitignore"),
  ).toHaveLength(1);
});

test("a paste split over several reads, and keys right after it, arrive whole and in order", async () => {
  const shot = file("shot.png");
  const take = filter();
  const whole = `x${pasted(shot)}after`;
  // The paste's start comes whole, as a terminal sends it, and its end in two pieces.
  const end = whole.indexOf("\x1b[201~") + 3;
  for (const piece of [whole.slice(0, 9), whole.slice(9, end), whole.slice(end)])
    take(Buffer.from(piece));
  take(Buffer.from("more"));
  const out = await afterCopies();
  expect(out).toMatch(
    new RegExp(`^x\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~aftermore$`),
  );
});

test("a file already in the agent's folder keeps its path", async () => {
  mkdirSync(join(agent, "sub"));
  const inside = join(agent, "sub", "notes.txt");
  writeFileSync(inside, "notes");
  filter()(Buffer.from(pasted(inside)));
  expect(await afterCopies()).toBe(pasted(inside));
});
