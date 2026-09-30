import { describe, expect, test } from "bun:test";
import { defaultSkills } from "./skills";

// Two kinds of skill. An agent uses spec and develop to work a task and
// report on it. The developer uses the others for their own verbs: add a
// task, see what goes on, show one task, and approve. Sending back has no
// skill: the developer types `skelcrew reject` themselves.
const agentSkills = ["spec", "develop"];
const developerSkills = ["add", "crew", "log", "approve"];
const allSkills = [...agentSkills, ...developerSkills];

// The CLI commands each skill may name. They come from the spec's CLI
// table. The agents' skills use the commands it marks "used by the
// skills", plus log, which only reads: the claim doesn't print the task's
// title, and the log does. They name approve and reject only to say that
// the developer runs them. The spec skill also adds a task, or asks for its spec, when the
// developer starts it with a title or with an Idea's number.
const commandsFor: Record<string, string[]> = {
  spec: ["add", "spec", "claim", "submit", "log", "approve", "reject"],
  develop: ["claim", "done", "give-up", "log", "approve", "reject"],
  add: ["add"],
  // Blocked tasks: crew gives the developer the retry and drop commands.
  crew: ["status", "retry", "drop"],
  log: ["status", "log", "approve", "reject", "retry", "drop"],
  approve: ["status", "log", "approve", "reject"],
};

function frontmatter(text: string): unknown {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match?.[1] === undefined ? null : Bun.YAML.parse(match[1]);
}

function skill(name: string): string {
  return defaultSkills.find((one) => one.path === `.agents/skills/${name}/SKILL.md`)?.text ?? "";
}

// The skill's text on one line, so a phrase is found wherever it wraps.
function flat(name: string): string {
  return skill(name).replaceAll(/\s+/g, " ");
}

// How often the pattern matches. The pattern must have the g flag.
function matches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

// Skills are wrapped at about 95 columns, so a command can break over two
// lines, such as "skelcrew" at the end of one line and "approve 12" at the
// start of the next. These patterns allow any spaces or line breaks between
// the words, so a wrapped command is still found.
const approveOrReject = /skelcrew\s+(approve|reject)\b/g;
// A prohibition, such as "Never run `skelcrew approve`". The command stands
// alone in its backticks, so "never ask first, run `skelcrew approve 12`"
// doesn't count.
const neverRun = /\bnever\s+run\s+`skelcrew\s+(approve|reject)`/gi;

describe("defaultSkills", () => {
  // Skills live in .agents/skills, so no one harness owns them. Init links
  // them into .claude/skills for Claude Code.
  test("are the agents' spec and develop, then the developer's own verbs, in .agents/skills", () => {
    expect(defaultSkills.map((one) => one.path)).toEqual(
      allSkills.map((name) => `.agents/skills/${name}/SKILL.md`),
    );
  });

  // argument-hint only changes how Claude Code shows the skill, and the
  // shared Agent Skills check refuses it, so it stays out.
  test("each starts with a name and a description, and no argument hint", () => {
    for (const name of allSkills) {
      const front = frontmatter(skill(name));
      expect(front).toMatchObject({ name, description: expect.any(String) });
      expect(front).not.toHaveProperty("argument-hint");
    }
  });

  // Not every harness has slash commands, so the description says in
  // plain words when the skill is for.
  test("each description says when to use it without needing a slash command", () => {
    const asks = {
      spec: "asks to spec task 12",
      develop: "asks to build task 12",
      add: "asks to add a task",
      crew: "asks what is going on",
      log: "asks where task 12 stands",
      approve: "asks to approve task 12",
    };
    expect(Object.keys(asks)).toEqual(allSkills);
    for (const [name, ask] of Object.entries(asks)) {
      expect(frontmatter(skill(name))).toMatchObject({
        description: expect.stringContaining(ask),
      });
    }
  });

  // Claude Code swaps $ARGUMENTS for what the developer typed. Other
  // harnesses would show it as it is, so the skills never use it. Nor do
  // they name one harness's tools.
  test("never rely on $ARGUMENTS or on one harness's tools", () => {
    for (const name of allSkills) {
      const text = flat(name);
      for (const word of ["$ARGUMENTS", "$0", "$1", "Bash tool", "AskUserQuestion", "Skill tool"]) {
        expect({ name, found: text.includes(word) }).toEqual({ name, found: false });
      }
    }
  });

  test("name the task the developer gave", () => {
    for (const name of ["spec", "develop", "log", "approve"]) {
      expect(flat(name)).toContain("the task the developer named, such as 12");
    }
  });

  // Claude Code starts each shell command fresh. Other harnesses may too,
  // so the skills don't say which one does.
  test("say that the harness may start each shell command fresh", () => {
    for (const name of agentSkills) {
      const text = flat(name);
      expect(text).not.toContain("Each shell command starts fresh");
      expect(text).toContain("Your harness may start each shell command fresh");
    }
  });

  test("use only the CLI commands the spec gives each skill", () => {
    expect(Object.keys(commandsFor)).toEqual(allSkills);
    for (const name of allSkills) {
      const used = [...skill(name).matchAll(/skelcrew\s+([a-z-]+)/g)].map(
        (match) => match[1] ?? "",
      );
      for (const command of used) {
        expect({ name, command, allowed: commandsFor[name]?.includes(command) }).toEqual({
          name,
          command,
          allowed: true,
        });
      }
    }
  });

  // The skills' method came from an earlier Skelcrew, whose tool worked
  // differently. An agent told to run one of these would fail, or do what
  // Skelcrew now does itself: agents here never push, open pull requests or
  // keep their own record. Add to this list when another old word turns up.
  //
  // The old `skelcrew show` command is still banned, as a command, in
  // every skill. The skills that were once called /idea and /show are now
  // /add and /log, like the CLI's commands, so their old names are banned
  // too.
  test("never name a command or place from the earlier Skelcrew", () => {
    const old = [
      "skelcrew show",
      "skelcrew move",
      "skelcrew comment",
      "skelcrew queue",
      "skelcrew export",
      "skelcrew release",
      "skelcrew block",
      "skelcrew list",
      "skelcrew trace",
      "skelcrew files",
      "skelcrew describe",
      "docs/TODO.md",
      "docs/ROADMAP.md",
      "docs/plans/",
      "docs/specs/",
      ".agents/roles",
      "run record",
      "pull request",
      "gh pr",
      "git push",
      "/code",
      "/plan",
      "/research",
      "/audit",
      "/run",
      // The skills' own old names, from before they matched the CLI.
      "/idea",
      "/show",
    ];
    for (const one of defaultSkills) {
      // The developer reads a merge's diff in the draft pull request that
      // Skelcrew opens. So a developer's skill may point to that draft.
      // Nothing else about pull requests is allowed, and the agents' skills
      // may not mention one at all.
      const developers = developerSkills.some((name) => one.path.includes(`/${name}/`));
      const whole = one.text.replaceAll(/\s+/g, " ");
      const text = developers ? whole.replaceAll("draft pull request", "draft") : whole;
      expect({ path: one.path, found: old.filter((word) => text.includes(word)) }).toEqual({
        path: one.path,
        found: [],
      });
    }
  });

  test("the spec skill claims the task and submits the spec", () => {
    const text = skill("spec");
    expect(text).toContain("skelcrew claim");
    expect(text).toContain("skelcrew submit");
  });

  // Typing /spec with a title is the ask for a spec, so the skill adds the
  // task and goes on. With an Idea's number, it asks for the spec itself
  // instead of stopping at the refused claim.
  test("the spec skill takes a title or a number, and says how it tells them apart", () => {
    const text = flat("spec");
    expect(text).toContain(
      "It is a task number when it is only digits, with or without a # in front, such as 12 or #12.",
    );
    expect(text).toContain("skelcrew add '<title>' --spec");
    expect(text).toContain("skelcrew spec 12");
    expect(text).toContain("Don't ask the developer to confirm first.");
  });

  test("the develop skill claims the task, reports done, and can give up", () => {
    const text = skill("develop");
    expect(text).toContain("skelcrew claim");
    expect(text).toContain("skelcrew done");
    expect(text).toContain("skelcrew give-up");
  });

  // Only the developer starts a task or approves. Claude must not do
  // either because the conversation seemed to call for it. Claude may add
  // an idea, give an overview, or show a task by itself, since they only
  // add a task or read.
  test("only the developer can start the ones that start or approve work", () => {
    for (const name of ["spec", "develop", "approve"]) {
      expect(frontmatter(skill(name))).toMatchObject({ "disable-model-invocation": true });
    }
    for (const name of ["add", "crew", "log"]) {
      expect(frontmatter(skill(name))).not.toHaveProperty("disable-model-invocation");
    }
  });

  test("ask for a task number instead of acting on nothing", () => {
    for (const name of ["develop", "log", "approve"]) {
      expect(skill(name)).toContain(
        "If you weren't given a task number, ask the developer which task, and wait.",
      );
    }
    expect(skill("spec")).toContain(
      "If you weren't given a task number or a title, ask the developer which task, and wait.",
    );
  });

  // Started without a number, $ARGUMENTS is empty, so "skelcrew claim
  // $ARGUMENTS" would read as a claim of nothing. The skill names the
  // number the developer gave instead.
  test("claim the task number the developer gave", () => {
    for (const name of agentSkills) {
      const text = flat(name);
      expect(text).not.toContain("claim $ARGUMENTS");
      expect(text).not.toContain("submit $ARGUMENTS");
      expect(text).toContain("with the task number the developer gave");
    }
  });

  // The CLI (PR #40) needs the task number on every report, and the session
  // the claim printed in SKELCREW_SESSION. Each shell command in Claude
  // Code starts fresh, so an export wouldn't last. The session goes in
  // front of each report instead.
  test("put the session and the task number on every report", () => {
    const reports = {
      spec: ["SKELCREW_SESSION=<session> skelcrew submit 12 --file -"],
      develop: [
        "SKELCREW_SESSION=<session> skelcrew done 12",
        "SKELCREW_SESSION=<session> skelcrew give-up 12 '<reason>'",
      ],
    };
    for (const [name, commands] of Object.entries(reports)) {
      const text = skill(name);
      expect(text).toContain("SKELCREW_SESSION=<the session it printed>");
      for (const command of commands) expect(text).toContain(command);
      // A report written without its task number fails.
      for (const bare of ["`skelcrew submit`", "`skelcrew done`", "`skelcrew give-up`"]) {
        expect(text).not.toContain(bare);
      }
    }
  });

  // The developer's commands carry no session: the developer isn't an
  // agent working a task.
  test("the developer's skills run their commands without a session", () => {
    for (const name of developerSkills) expect(skill(name)).not.toContain("SKELCREW_SESSION");
  });

  // The claim's answer doesn't name a worktree yet, so the skill can't
  // promise one.
  test("the develop skill stops if the claim doesn't say where to work", () => {
    const text = flat("develop");
    expect(text).not.toContain("The claim tells you the worktree");
    expect(text).toContain("If it doesn't, stop and tell the developer.");
  });

  // These files decide what an agent may do: which checks run, whether a
  // spec needs approval, which paths are critical, what Claude Code asks
  // about, and what the skills say. An agent that edits them changes its
  // own rules.
  test("never edit the files that set the rules", () => {
    for (const name of agentSkills) {
      const text = flat(name);
      expect(text).toContain("Never edit `.skelcrew/workflow.yml`");
      expect(text).toContain("`.claude/settings.json`");
      expect(text).toContain("`.agents/skills/`");
      expect(text).not.toContain("`.claude/skills/`");
      expect(text).not.toContain("edit the checks");
    }
  });

  // An agent never approves and never sends back. Its skills name approve
  // and reject only to forbid them. Each mention must be a plain "never run"
  // of the bare command. A line such as "Never ask the developer first: run
  // `skelcrew approve 12`" says "never", but tells the agent to approve.
  test("the agents' skills never approve or send back", () => {
    for (const name of agentSkills) {
      const text = skill(name);
      expect(text).toMatch(/never\s+run\s+`skelcrew\s+approve`/i);
      expect(text).toMatch(/never\s+run\s+`skelcrew\s+reject`/i);
      expect({ name, mentions: matches(text, approveOrReject) }).toEqual({
        name,
        mentions: matches(text, neverRun),
      });
    }
  });

  // /approve is the one skill that runs approve. It runs only the plain
  // form, because Claude Code's ask rule in .claude/settings.json matches
  // the command as written. So `sh -c 'skelcrew approve 12'`, a path to
  // the program, or a variable set in front could run without the
  // developer's confirmation.
  test("the approve skill runs only the plain form of skelcrew approve", () => {
    const text = skill("approve");
    expect(text).toContain("```\nskelcrew approve 12\n```");
    // Every mention is the whole plain command for the one task: it starts
    // a line or follows a backtick, and 12 ends it. So nothing stands in
    // front, such as `do` in a loop, and nothing follows, such as a second
    // number. The number is the placeholder, not a variable such as $n or
    // another task, such as 13.
    const plain = /(^|`)skelcrew approve 12(?=`|$)/gm;
    expect(matches(text, /skelcrew\s+approve/g)).toBe(matches(text, plain));
    expect(text).not.toContain("$");
    // The approve skill hands reject to the developer, as a line they type.
    expect(matches(text, /skelcrew\s+reject/g)).toBe(matches(text, /! skelcrew reject/g));
    for (const wrapper of ["`sh -c`", "a path to the program", "`bunx`", "`env`"]) {
      expect(text).toContain(wrapper);
    }
  });

  test("the approve skill says the harness asks the developer to confirm, and that this is intended", () => {
    const text = flat("approve");
    expect(text).toContain("Claude Code will ask the developer to confirm.");
    expect(text).toContain("This is intended.");
  });

  test("the approve skill shows the task before it approves", () => {
    const text = skill("approve");
    const shows = text.indexOf("## 1. Show the task");
    const approves = text.indexOf("## 2. Approve it");
    expect(shows).toBeGreaterThan(-1);
    expect(approves).toBeGreaterThan(shows);
  });

  // /log only reads. It hands the developer the two commands to type, and
  // never runs either itself. Nor does /crew.
  test("the log skill ends with both lines for the developer, and runs neither", () => {
    const text = skill("log");
    const approve = "! skelcrew approve 12";
    const reject = "! skelcrew reject 12 '<note>'";
    expect(text).toContain(`${approve}\n${reject}`);
    // Besides those two lines, each mention, even one wrapped over two
    // lines, must be a plain "never run".
    const lines = text.split("\n").filter((line) => line === approve || line === reject);
    expect(matches(text, approveOrReject)).toBe(lines.length + matches(text, neverRun));
    expect(flat("log")).toContain(
      "Never run `skelcrew approve` yourself, and never run `skelcrew reject`.",
    );
  });

  test("the crew skill never approves or sends back", () => {
    expect(matches(skill("crew"), approveOrReject)).toBe(0);
  });

  // What waits on the developer comes first, then who works on what, then
  // the rest. `skelcrew status` has no form for programs yet, so the skill
  // reads its text.
  test("the crew skill reads status and tells what waits on the developer first", () => {
    const text = skill("crew");
    expect(text).toContain("skelcrew status");
    const order = ["### Waiting on you", "### Who is working on what", "### The rest"].map(
      (heading) => text.indexOf(heading),
    );
    for (const place of order) expect(place).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(flat("crew")).toContain("Leave out dropped tasks, unless the developer asks for them.");
  });

  test("the log skill reads the task's line in status and its log", () => {
    const text = skill("log");
    expect(text).toContain("skelcrew status");
    expect(text).toContain("skelcrew log 12");
  });

  test("the log skill says what to look at for a merge that waits", () => {
    const text = flat("log");
    for (const part of [
      "draft pull request",
      "git diff --stat",
      "acceptance criterion",
      "outside the spec's scope",
      "changed tests",
      "critical",
    ]) {
      expect(text).toContain(part);
    }
  });

  // The developer sends work back by typing `skelcrew reject` themselves.
  // There is no skill for it, so no skill may point to one.
  test("no skill points to a /reject skill", () => {
    for (const one of defaultSkills) {
      expect({ path: one.path, found: one.text.includes("/reject") }).toEqual({
        path: one.path,
        found: false,
      });
    }
  });

  // Inside double quotes the shell still runs backticks and expands $. So
  // a title such as "Fix `rm -rf` in $HOME" would run a command. Text the
  // developer typed goes in single quotes, where the shell changes nothing.
  test("no skill puts the developer's text in double quotes", () => {
    for (const one of defaultSkills) {
      const found = ['"<title>"', '"<note>"', '"<reason>"'].filter((it) => one.text.includes(it));
      expect({ path: one.path, found }).toEqual({ path: one.path, found: [] });
    }
  });

  // A single quote inside the text would end the quoted part early. The
  // skills say how to write one: '\'' closes the quote, adds a quote, and
  // opens it again.
  test("the skills that pass the developer's text say how to quote it", () => {
    for (const name of ["add", "spec", "log", "approve"]) {
      const text = flat(name);
      expect({ name, single: text.includes("in single quotes") }).toEqual({ name, single: true });
      expect({ name, escape: text.includes("`'\\''`") }).toEqual({ name, escape: true });
    }
  });

  // An idea waits until the developer asks for its spec. So /add only
  // captures it.
  test("the add skill adds the task as an Idea, and asks for no spec", () => {
    const text = flat("add");
    expect(text).toContain("skelcrew add '<title>'");
    expect(text).not.toContain("--spec");
  });

  // The spec skill's method: understand the code before asking anything,
  // ask once, write the spec in a fixed shape, and run every sentence about
  // what the code does today instead of trusting memory.
  test("the spec skill reads the task and the code before it asks", () => {
    const text = skill("spec");
    expect(text).toContain("skelcrew log 12");
    const ground = text.indexOf("### Ground it in the code first");
    const ask = text.indexOf("### Ask once, with your answers");
    expect(ground).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(ground);
  });

  test("the spec skill asks its questions together, each with a recommended answer", () => {
    const text = flat("spec");
    expect(text).toContain("in one message, each question with the answer you recommend first");
    expect(text).not.toContain("one at a time");
  });

  test("the spec skill gives the spec a fixed shape inside its scope", () => {
    const text = skill("spec");
    const parts = ["Goal", "Today", "Change", "Approach", "Tests", "Out of scope"];
    const places = parts.map((part) => text.indexOf(`**${part}:**`));
    for (const place of places) expect(place).toBeGreaterThan(-1);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  test("the spec skill runs every sentence about today before it submits", () => {
    const text = skill("spec");
    const check = text.indexOf("### Check every sentence about today");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(text.indexOf("## 3. Submit it"));
    expect(flat("spec")).toContain("run the command or read the line");
  });

  // The CLI's help says how to pass the spec.
  test("the spec skill reads how to pass the spec before submitting", () => {
    expect(skill("spec")).toContain("skelcrew submit --help");
  });

  // The develop skill's method, in order: understand the code, test first,
  // review the diff against the spec in rounds, verify by running it, then
  // report done. Skelcrew's checks run the tests, but nothing else reads
  // the code against the spec before the developer does.
  test("the develop skill understands, builds test first, reviews and verifies before done", () => {
    const text = skill("develop");
    const steps = [
      "### Understand first",
      "### Test first",
      "## 3. Review your own diff",
      "## 4. Verify by running it",
      "## 5. Report it done",
    ].map((heading) => text.indexOf(heading));
    for (const step of steps) expect(step).toBeGreaterThan(-1);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(text.indexOf("SKELCREW_SESSION=<session> skelcrew done 12")).toBeGreaterThan(
      steps[4] ?? -1,
    );
  });

  test("the develop skill writes the failing test first", () => {
    expect(skill("develop")).toContain("Write the failing test first.");
  });

  test("the develop skill reviews at most three rounds, then asks the developer", () => {
    const text = flat("develop");
    expect(text).toContain("At most three rounds.");
    expect(text).toContain("don't report done. Tell the developer what remains");
  });

  test("the develop skill verifies each acceptance criterion by running something", () => {
    expect(flat("develop")).toContain("establish each acceptance criterion by running something");
  });

  test("the develop skill reports honestly", () => {
    expect(flat("develop")).toContain(
      "Never claim a check ran, or a criterion holds, unless you saw it.",
    );
  });

  test("the develop skill names each thing it must never do", () => {
    const text = skill("develop");
    for (const never of [
      "Never push",
      "force push",
      "--no-verify",
      "skip a hook",
      ".skelcrew/workflow.yml",
      "Never weaken a test",
      "Never approve",
      "Never merge",
    ]) {
      expect(text).toContain(never);
    }
  });

  test("stop when the task is blocked or dropped", () => {
    for (const name of agentSkills) {
      const text = flat(name);
      expect(text).toContain(
        "If a call is refused because the task was blocked or dropped, stop at once.",
      );
      expect(text).not.toContain("let go");
    }
  });
});
