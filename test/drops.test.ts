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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyDrops,
  dropSignal,
  dropsFolder,
  largestDrop,
  pasteFilter,
} from "../src/screen/drops.ts";

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

// A filter that copies into the folder `where` names, asking as the screen does, and keeps what
// it sends on.
const filter = (where: () => string = () => agent) =>
  pasteFilter(
    (bytes) => {
      sent += Buffer.from(bytes).toString();
    },
    {
      where: async (ask) => {
        ask();
        return where();
      },
      put: async (folder, files) => copyDrops(folder, files),
    },
  );

// Makes a file in the test's home and returns its path.
function file(name: string, text = `the text of ${name}`): string {
  const path = join(home, name);
  writeFileSync(path, text);
  return path;
}

// Returns what reached the screen once the filter has had time to copy, with each drop's
// question, which the screen keeps from the agent.
async function sentOn(): Promise<string> {
  // Longer than the filter's wait after a lone Esc.
  await Bun.sleep(150);
  return sent;
}
// Returns what reached the agent once the filter has had time to copy.
async function afterCopies(): Promise<string> {
  return (await sentOn()).replaceAll(dropSignal, "");
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

test("a paste split over several reads arrives whole, and keys after it follow it", async () => {
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

test("everything sent after a drop waits for its paste, then follows in order", async () => {
  const shot = file("shot.png");
  let finish: () => void = () => {};
  const take = pasteFilter(
    (bytes) => {
      sent += Buffer.from(bytes).toString();
    },
    {
      where: async (ask) => {
        ask();
        return agent;
      },
      put: (folder, files) =>
        new Promise((done) => {
          finish = () => done(copyDrops(folder, files));
        }),
    },
  );
  // Enter right after the drop, then an arrow, a turn of the wheel and more typing.
  take(Buffer.from(`${pasted(shot)}\r`));
  take(Buffer.from("\x1b[A"));
  take(Buffer.from("\x1b[<65;3;4M"));
  take(Buffer.from("q"));
  await Bun.sleep(20);
  expect(sent).toBe(dropSignal);
  finish();
  const out = await sentOn();
  expect(out).toMatch(
    new RegExp(
      `^${dropSignal.replaceAll("[", "\\[")}\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~\\r\\x1b\\[A\\x1b\\[<65;3;4Mq$`,
    ),
  );
});

test("a copy runs off the screen's way, so nothing waits on it", async () => {
  const shot = file("shot.png");
  const copying = copyDrops(agent, [shot]);
  // Nothing was copied while the call ran: the copy happens while keys, the mouse and resizes
  // go on.
  expect(existsSync(join(agent, dropsFolder))).toBe(false);
  const [copy] = await copying;
  expect(readFileSync(copy ?? "", "utf8")).toBe("the text of shot.png");
});

test("a paste's start split anywhere across two reads is still seen, and the question never lands inside it", async () => {
  const shot = file("shot.png");
  const whole = `x${pasted(shot)}y`;
  // Each place inside the start, from after its Esc to before its last byte. The part sent before
  // the cut is closed as an empty paste, so the question and the paste each go in whole.
  const copied = `\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~`;
  const question = dropSignal.replaceAll("[", "\\[");
  for (let cut = 2; cut < 7; cut++) {
    sent = "";
    const take = filter();
    take(Buffer.from(whole.slice(0, cut)));
    take(Buffer.from(whole.slice(cut)));
    const out = await sentOn();
    expect(out).toMatch(new RegExp(`^x\\x1b\\[200~\\x1b\\[201~${question}${copied}y$`));
  }
});

test("a text paste whose start is split across two reads passes byte for byte", async () => {
  const whole = `x${pasted("hello there")}y`;
  for (let cut = 2; cut < 7; cut++) {
    sent = "";
    const take = filter();
    take(Buffer.from(whole.slice(0, cut)));
    take(Buffer.from(whole.slice(cut)));
    expect(await sentOn()).toBe(whole);
  }
});

test("a missing path or a folder whose paste's start is split across two reads passes byte for byte", async () => {
  for (const path of [join(home, "gone.png"), join(home, "Screen Shots")]) {
    const whole = `x${pasted(path)}y`;
    for (let cut = 2; cut < 7; cut++) {
      sent = "";
      const take = filter();
      take(Buffer.from(whole.slice(0, cut)));
      take(Buffer.from(whole.slice(cut)));
      expect(await sentOn()).toBe(whole);
    }
  }
});

test("Enter after a lone Esc and a paste that copies nothing still follows the paste", async () => {
  const take = filter();
  const missing = join(home, "gone.png");
  take(Buffer.from("\x1b"));
  take(Buffer.from(`${pasted(missing)}\r`));
  expect(await sentOn()).toBe(`\x1b${pasted(missing)}\r`);
});

test("the question never goes in right after a lone Esc, which more of a sequence may follow", async () => {
  const shot = file("shot.png");
  const take = filter();
  take(Buffer.from("\x1b"));
  take(Buffer.from(pasted(shot)));
  await Bun.sleep(20);
  expect(sent).toBe("\x1b");
  const out = await sentOn();
  expect(out.startsWith(`\x1b${dropSignal}\x1b[200~${agent}/`)).toBe(true);
});

test("a double-quoted path with an escaped quote in its name is copied", async () => {
  const odd = file('say "hi".txt');
  filter()(Buffer.from(pasted(`"${odd.replaceAll('"', '\\"')}"`)));
  const out = await afterCopies();
  expect(out).toMatch(
    new RegExp(`^\\x1b\\[200~"${agent}/${dropsFolder}/[^/]+/say \\\\"hi\\\\"\\.txt"\\x1b\\[201~$`),
  );
  const copy = out.slice('\x1b[200~"'.length, -'"\x1b[201~'.length).replaceAll('\\"', '"');
  expect(readFileSync(copy, "utf8")).toBe('the text of say "hi".txt');
});

test("the drop's question goes on after the keys before it and ahead of the paste", async () => {
  const shot = file("shot.png");
  filter()(Buffer.from(`\x1b[1;4B${pasted(shot)}`));
  const out = await sentOn();
  expect(out.startsWith(`\x1b[1;4B${dropSignal}\x1b[200~${agent}/`)).toBe(true);
});

test("a link in the agent's folder that leads out, or a path with .., is copied", async () => {
  const shot = file("shot.png");
  symlinkSync(shot, join(agent, "out.png"));
  const take = filter();
  take(Buffer.from(pasted(join(agent, "out.png"))));
  const linked = await afterCopies();
  expect(linked.startsWith(`\x1b[200~${agent}/${dropsFolder}/`)).toBe(true);
  expect(linked.endsWith("/out.png\x1b[201~")).toBe(true);
  sent = "";
  take(Buffer.from(pasted(`${agent}/../shot.png`)));
  expect((await afterCopies()).startsWith(`\x1b[200~${agent}/${dropsFolder}/`)).toBe(true);
});

test("a file already in the agent's folder keeps its path", async () => {
  mkdirSync(join(agent, "sub"));
  const inside = join(agent, "sub", "notes.txt");
  writeFileSync(inside, "notes");
  filter()(Buffer.from(pasted(inside)));
  expect(await afterCopies()).toBe(pasted(inside));
});
