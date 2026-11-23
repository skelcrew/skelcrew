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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyDrops,
  type Drop,
  dropSignal,
  dropsFolder,
  escapeTime,
  largestDrop,
  pasteFilter,
  runWithDrops,
} from "../src/screen/drops.ts";

let home = "";
let agent = "";
let sent = "";
let elsewhere = 0;
let copying = new Set<Promise<unknown>>();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-drops-test-")));
  agent = join(home, "agent");
  mkdirSync(agent);
  mkdirSync(join(home, "Screen Shots"));
  sent = "";
  elsewhere = 0;
  copying = new Set();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// A filter that copies into the folder `where` names, asking as the screen does, and keeps what
// it sends on, and each copy it makes until it is done.
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
      put: (folder, files) => {
        const copies = copyDrops(folder, files);
        copying.add(copies);
        copies.finally(() => copying.delete(copies));
        return copies;
      },
      elsewhere: () => {
        elsewhere++;
      },
    },
  );

// Makes a file in the test's home and returns its path.
function file(name: string, text = `the text of ${name}`): string {
  const path = join(home, name);
  writeFileSync(path, text);
  return path;
}

// Returns what reached the screen once the filter has had time to copy, and every copy it began
// is done, with each drop's question, which the screen keeps from the agent. A slow machine can
// take longer to copy than the wait.
async function sentOn(): Promise<string> {
  while (true) {
    // Longer than the filter's wait after a lone Esc.
    await Bun.sleep(150);
    if (copying.size === 0) return sent;
    await Promise.allSettled(copying);
  }
}
// Returns what reached the agent once the filter has had time to copy.
async function afterCopies(): Promise<string> {
  return (await sentOn()).replaceAll(dropSignal, "");
}

const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`;

// Waits until the screen has taken a snapshot of a dropped file holding each of `texts`.
async function snapshotted(...texts: string[]): Promise<void> {
  const held = () =>
    readdirSync(tmpdir())
      .filter((name) => name.startsWith("skelcrew-drop-"))
      .map((name) => {
        try {
          return readFileSync(join(tmpdir(), name, "file"), "utf8");
        } catch {
          return "";
        }
      });
  for (let waited = 0; waited < 250; waited++) {
    const now = held();
    if (texts.every((text) => now.includes(text))) return;
    await Bun.sleep(20);
  }
}

// Waits until `done` says yes, for up to five seconds.
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 250; waited++) await Bun.sleep(20);
}

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
  expect(elsewhere).toBe(0);
  const [copy = ""] = copies(out);
  expect(readFileSync(copy, "utf8")).toBe("the text of shot.png");
  // Git never sees the copies, so a builder doesn't commit them.
  expect(readFileSync(join(agent, dropsFolder, ".gitignore"), "utf8")).toBe("*\n");
});

test("a dropped file named .gitignore is copied like any other", async () => {
  mkdirSync(join(home, "project"));
  const ignore = join(home, "project", ".gitignore");
  writeFileSync(ignore, "dist\n");
  filter()(Buffer.from(pasted(ignore)));
  const [copy = ""] = copies(await afterCopies());
  expect(copy.endsWith("/.gitignore")).toBe(true);
  expect(readFileSync(copy, "utf8")).toBe("dist\n");
});

test("a .gitignore the agent made a link out of its folder is never written through, and nothing is copied", async () => {
  // Git doesn't read a .gitignore that is a link, so a copy there would show to it.
  const yours = file("yours.txt", "*\n");
  mkdirSync(join(agent, dropsFolder));
  symlinkSync(yours, join(agent, dropsFolder, ".gitignore"));
  const shot = file("shot.png");
  filter()(Buffer.from(pasted(shot)));
  expect(await afterCopies()).toBe(pasted(shot));
  expect(readFileSync(yours, "utf8")).toBe("*\n");
  expect(readdirSync(join(agent, dropsFolder))).toEqual([".gitignore"]);
});

test("a drops folder whose .gitignore doesn't ignore everything gets no copies, which git would see", async () => {
  mkdirSync(join(agent, dropsFolder));
  writeFileSync(join(agent, dropsFolder, ".gitignore"), "*.tmp\n");
  const shot = file("shot.png");
  filter()(Buffer.from(pasted(shot)));
  expect(await afterCopies()).toBe(pasted(shot));
  expect(readdirSync(join(agent, dropsFolder))).toEqual([".gitignore"]);
  expect(readFileSync(join(agent, dropsFolder, ".gitignore"), "utf8")).toBe("*.tmp\n");
});

test("a paste of paths ending in a space, whose end comes cut in two, is still copied", async () => {
  const shot = file("shot.png");
  const whole = pasted(`${shot} `);
  const end = whole.length - "\x1b[201~".length;
  for (let at = end + 1; at < whole.length; at++) {
    sent = "";
    const take = filter();
    take(Buffer.from(whole.slice(0, at)));
    take(Buffer.from(whole.slice(at)));
    const out = await afterCopies();
    expect(out).toMatch(
      new RegExp(`^\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png \\x1b\\[201~$`),
    );
  }
});

test("a drops folder the agent made a link out of its folder is never written through", async () => {
  // A link out to a folder of yours, with a .gitignore of its own.
  const yours = join(home, "yours");
  mkdirSync(yours);
  writeFileSync(join(yours, ".gitignore"), "node_modules\n");
  symlinkSync(yours, join(agent, dropsFolder));
  const shot = file("shot.png");
  filter()(Buffer.from(pasted(shot)));
  expect(await afterCopies()).toBe(pasted(shot));
  expect(readdirSync(yours)).toEqual([".gitignore"]);
  expect(readFileSync(join(yours, ".gitignore"), "utf8")).toBe("node_modules\n");
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
  expect(elsewhere).toBe(0);
});

test("a text paste goes on as it comes, once its start shows it isn't paths", async () => {
  const shot = file("shot.png");
  const take = filter();
  take(Buffer.from("\x1b[200~hello"));
  expect(sent).toBe("\x1b[200~hello");
  take(Buffer.from(" there\x1b[20"));
  expect(sent).toBe("\x1b[200~hello there\x1b[20");
  // Its end, split across reads, is still found, so a drop after it is copied.
  take(Buffer.from(`1~${pasted(shot)}`));
  const out = await afterCopies();
  expect(out).toMatch(
    new RegExp(
      `^\\x1b\\[200~hello there\\x1b\\[201~\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~$`,
    ),
  );
});

test("a paste too long to be paths goes on before its end", () => {
  const take = filter();
  const long = `/${"a".repeat(70_000)}`;
  take(Buffer.from(`\x1b[200~${long}`));
  expect(sent).toBe(`\x1b[200~${long}`);
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
  // A folder, a file you can't read and one too big are here, so none of them says a file is
  // on another machine.
  sent = "";
  elsewhere = 0;
  take(Buffer.from(pasted(`${join(home, "Screen Shots")} ${big}`)));
  expect(await afterCopies()).toBe(pasted(`${join(home, "Screen Shots")} ${big}`));
  expect(elsewhere).toBe(0);
  // Run as root, the file can still be read, so it is only checked where it can't be.
  if (process.getuid?.() !== 0) {
    sent = "";
    take(Buffer.from(pasted(unreadable)));
    expect(await afterCopies()).toBe(pasted(unreadable));
    expect(elsewhere).toBe(0);
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

test("a dropped path that isn't on this machine passes as it came, and says so once", async () => {
  const laptop = "/Users/simon/Desktop/Screen\\ Shot.png /var/folders/x/T/shot.png";
  const take = filter();
  take(Buffer.from(pasted(laptop)));
  take(Buffer.from("\r"));
  expect(await afterCopies()).toBe(`${pasted(laptop)}\r`);
  expect(elsewhere).toBe(1);
  // Keys after it say nothing more.
  take(Buffer.from("abc"));
  await afterCopies();
  expect(elsewhere).toBe(1);
});

test("files dropped together are each copied, however much they add up to, and their snapshots go", async () => {
  const halves = ["one.bin", "two.bin"].map((name) => {
    const path = file(name, "");
    Bun.spawnSync(["truncate", "-s", String(largestDrop / 2 + 1), path]);
    return path;
  });
  filter()(Buffer.from(pasted(halves.join(" "))));
  for (let waited = 0; !sent.includes("\x1b[201~") && waited < 500; waited++) await Bun.sleep(20);
  expect(copies(sent.replaceAll(dropSignal, ""))).toHaveLength(2);
  await Bun.sleep(50);
  const left = readdirSync(tmpdir())
    .filter((name) => name.startsWith("skelcrew-drop-"))
    .filter(
      (name) =>
        statSync(join(tmpdir(), name, "file"), { throwIfNoEntry: false })?.size ===
        largestDrop / 2 + 1,
    );
  expect(left).toEqual([]);
}, 15000);

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

test("a dropped file is read at once, so one deleted while the drop asks where it goes still arrives", async () => {
  const shot = file("shot.png");
  const take = filter(() => {
    rmSync(shot);
    return agent;
  });
  take(Buffer.from(pasted(shot)));
  const [copy = ""] = copies(await afterCopies());
  expect(readFileSync(copy, "utf8")).toBe("the text of shot.png");
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
  await until(() => sent !== "");
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

test("files dropped while an earlier drop is still on its way are read at once, and the pastes keep their order", async () => {
  const first = file("first.png");
  const second = file("second.png");
  const third = file("third.png");
  let finish: () => void = () => {};
  let held = true;
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
        held
          ? new Promise((done) => {
              held = false;
              finish = () => done(copyDrops(folder, files));
            })
          : copyDrops(folder, files),
    },
  );
  take(Buffer.from(pasted(first)));
  await until(() => !held);
  take(Buffer.from(pasted(second)));
  take(Buffer.from(pasted(third)));
  await snapshotted("the text of second.png", "the text of third.png");
  const snapshots = readdirSync(tmpdir()).filter((name) =>
    name.startsWith(`skelcrew-drop-${process.pid}-`),
  );
  expect(snapshots.length).toBeGreaterThan(0);
  for (const name of snapshots) expect(statSync(join(tmpdir(), name)).mode & 0o777).toBe(0o700);
  rmSync(second);
  rmSync(third);
  finish();
  await until(() => copies(sent).length === 3);
  const found = copies(await afterCopies());
  expect(found.map((copy) => copy.slice(copy.lastIndexOf("/") + 1))).toEqual([
    "first.png",
    "second.png",
    "third.png",
  ]);
  expect(found.map((copy) => readFileSync(copy, "utf8"))).toEqual([
    "the text of first.png",
    "the text of second.png",
    "the text of third.png",
  ]);
});

test("the same path dropped twice while an earlier drop is on its way keeps what each drop held", async () => {
  const first = file("first.png");
  const shot = file("shot.png", "before");
  let finish: () => void = () => {};
  let held = true;
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
        held
          ? new Promise((done) => {
              held = false;
              finish = () => done(copyDrops(folder, files));
            })
          : copyDrops(folder, files),
    },
  );
  take(Buffer.from(pasted(first)));
  await until(() => !held);
  take(Buffer.from(pasted(shot)));
  await snapshotted("before");
  writeFileSync(shot, "after");
  take(Buffer.from(pasted(shot)));
  await snapshotted("before", "after");
  rmSync(shot);
  finish();
  await until(() => copies(sent).length === 3);
  const found = copies(await afterCopies());
  expect(found.map((copy) => readFileSync(copy, "utf8"))).toEqual([
    "the text of first.png",
    "before",
    "after",
  ]);
});

test("a copy runs off the screen's way, so nothing waits on it", async () => {
  const shot = file("shot.png");
  const copying = copyDrops(agent, [{ path: shot, snapshot: shot }]);
  // Nothing was copied while the call ran: the copy happens while keys, the mouse and resizes
  // go on.
  expect(existsSync(join(agent, dropsFolder))).toBe(false);
  const [copy] = await copying;
  expect(readFileSync(copy ?? "", "utf8")).toBe("the text of shot.png");
});

test("a paste's start split anywhere across two reads is still seen, and the question never lands inside it", async () => {
  const shot = file("shot.png");
  const whole = `x${pasted(shot)}y`;
  // Each place inside the start, from after its Esc to before its last byte. The part before the
  // cut waits for the rest, so the question goes in first, and the paste whole after it.
  const copied = `\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~`;
  const question = dropSignal.replaceAll("[", "\\[");
  for (let cut = 2; cut < 7; cut++) {
    sent = "";
    const take = filter();
    take(Buffer.from(whole.slice(0, cut)));
    take(Buffer.from(whole.slice(cut)));
    const out = await sentOn();
    expect(out).toMatch(new RegExp(`^x${question}${copied}y$`));
  }
});

test("a paste of a file split anywhere in its start goes on byte for byte when nothing is copied", async () => {
  const shot = file("shot.png");
  const whole = `x${pasted(shot)}y`;
  // The sidebar names no agent, as while your typing goes to it, or the copy fails.
  const drops: Drop[] = [
    { where: async () => null, put: async (folder, files) => copyDrops(folder, files) },
    { where: async () => agent, put: async (_folder, files) => files.map(() => null) },
  ];
  for (const drop of drops) {
    for (let cut = 2; cut < 7; cut++) {
      sent = "";
      const take = pasteFilter((bytes) => {
        sent += Buffer.from(bytes).toString();
      }, drop);
      take(Buffer.from(whole.slice(0, cut)));
      take(Buffer.from(whole.slice(cut)));
      expect(await sentOn()).toBe(whole);
    }
  }
});

test("a paste of a file whose start is cut after more than its Esc is still copied when the rest comes late", async () => {
  // As over a slow link: the rest of the start comes a while after its first bytes.
  const shot = file("shot.png");
  const whole = pasted(shot);
  const copied = `^${dropSignal.replaceAll("[", "\\[")}\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~$`;
  for (let cut = 2; cut < "\x1b[200~".length; cut++) {
    sent = "";
    const take = filter();
    take(Buffer.from(whole.slice(0, cut)));
    await Bun.sleep(200);
    expect(sent).toBe("");
    take(Buffer.from(whole.slice(cut)));
    expect(await sentOn()).toMatch(new RegExp(copied));
  }
});

test("a paste start whose rest never comes goes on as it came, half a second later", async () => {
  const take = filter();
  take(Buffer.from("x\x1b[20"));
  await Bun.sleep(300);
  expect(sent).toBe("x");
  await Bun.sleep(400);
  expect(sent).toBe("x\x1b[20");
});

test("a paste of a file whose rest comes after a lone Esc was let go goes on as it came", async () => {
  // A lone Esc is most often the Esc key, and goes on at once, so tmux takes it as one.
  const shot = file("shot.png");
  const whole = pasted(shot);
  const take = filter();
  take(Buffer.from(whole.slice(0, 1)));
  await Bun.sleep(escapeTime * 3);
  expect(sent).toBe("\x1b");
  take(Buffer.from(whole.slice(1)));
  expect(await sentOn()).toBe(whole);
  expect(existsSync(join(agent, dropsFolder))).toBe(false);
});

test("the start of a paste cut at the end of a read goes on alone if the rest is late", async () => {
  const take = filter();
  take(Buffer.from("x\x1b"));
  expect(sent).toBe("x");
  // Once tmux too stopped waiting for the rest.
  await Bun.sleep(escapeTime * 3);
  expect(sent).toBe("x\x1b");
  take(Buffer.from("[A"));
  expect(sent).toBe("x\x1b[A");
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

test("the question waits past a lone Esc's moment for a longer sequence still on its way", async () => {
  const shot = file("shot.png");
  const take = filter();
  // A mouse event with its last bytes still to come, and the drop.
  take(Buffer.from("\x1b[<0;3;4"));
  take(Buffer.from(pasted(shot)));
  await Bun.sleep(300);
  expect(sent).toBe("\x1b[<0;3;4");
  // Its rest never came, so after a second the question goes in, after the part sent.
  await Bun.sleep(900);
  const out = await sentOn();
  expect(out.startsWith(`\x1b[<0;3;4${dropSignal}\x1b[200~${agent}/`)).toBe(true);
});

test("after an Esc whose rest comes only after the drop, everything keeps its order", async () => {
  const shot = file("shot.png");
  const take = filter();
  // The terminal sent the paste between the Esc and the rest, so it is already split there. By
  // the time the question goes in, tmux has long taken the Esc as the Esc key.
  take(Buffer.from("\x1b"));
  take(Buffer.from(pasted(shot)));
  await Bun.sleep(100);
  take(Buffer.from("[A"));
  const out = await sentOn();
  expect(out).toMatch(
    new RegExp(
      `^\\x1b${dropSignal.replaceAll("[", "\\[")}\\x1b\\[200~${agent}/${dropsFolder}/[^/]+/shot\\.png\\x1b\\[201~\\[A$`,
    ),
  );
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

test("a screen that opens deletes the snapshots a screen that ended left, never a running one's", async () => {
  const ended = Bun.spawn(["true"]);
  await ended.exited;
  const left = mkdtempSync(join(tmpdir(), `skelcrew-drop-${ended.pid}-`));
  writeFileSync(join(left, "file"), "an old drop");
  const running = mkdtempSync(join(tmpdir(), `skelcrew-drop-${process.pid}-`));
  try {
    await runWithDrops(["true"], { where: async () => null, put: async () => [] });
    expect(existsSync(left)).toBe(false);
    expect(existsSync(running)).toBe(true);
  } finally {
    rmSync(left, { recursive: true, force: true });
    rmSync(running, { recursive: true, force: true });
  }
});

test("a screen that closes while a drop is still being copied or sent leaves no snapshot of it", async () => {
  const shot = file("shot.png", "");
  Bun.spawnSync(["truncate", "-s", String(20 * 1024 * 1024), shot]);
  const take = pasteFilter(() => {}, {
    where: async () => agent,
    put: () => new Promise(() => {}),
  });
  take(Buffer.from(pasted(shot)));
  await take.close();
  await Bun.sleep(200);
  const mine = readdirSync(tmpdir()).filter((name) =>
    name.startsWith(`skelcrew-drop-${process.pid}-`),
  );
  expect(mine).toEqual([]);
});

test("a screen opens when your temporary folder is missing", async () => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(home, "no-such-folder");
  try {
    expect(await runWithDrops(["true"], { where: async () => null, put: async () => [] })).toBe(0);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});
