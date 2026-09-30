import { describe, expect, test } from "bun:test";
import { defaultSkills } from "./skills";

// The skills an agent in your harness uses to report. They are the
// commands the spec's CLI table marks "used by the skills", plus approve,
// which a skill names only to say that the developer runs it, and log,
// which only reads: the claim doesn't print the task's title, and the log
// does.
const skillCommands = ["claim", "submit", "done", "ask", "give-up", "approve", "log"];

function frontmatter(text: string): unknown {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match?.[1] === undefined ? null : Bun.YAML.parse(match[1]);
}

function skill(name: string): string {
  return defaultSkills.find((one) => one.path === `.agents/skills/${name}/SKILL.md`)?.text ?? "";
}

describe("defaultSkills", () => {
  // Skills live in .agents/skills, so no one harness owns them. Init links
  // them into .claude/skills for Claude Code.
  test("are the spec and develop skills, in .agents/skills", () => {
    expect(defaultSkills.map((one) => one.path)).toEqual([
      ".agents/skills/spec/SKILL.md",
      ".agents/skills/develop/SKILL.md",
    ]);
  });

  // argument-hint only changes how Claude Code shows the skill, and the
  // shared Agent Skills check refuses it, so it stays out.
  test("each starts with a name and a description, and no argument hint", () => {
    for (const name of ["spec", "develop"]) {
      const front = frontmatter(skill(name));
      expect(front).toMatchObject({ name, description: expect.any(String) });
      expect(front).not.toHaveProperty("argument-hint");
    }
  });

  // Not every harness has slash commands, so the description says in
  // plain words when the skill is for.
  test("each description says when to use it without needing a slash command", () => {
    const asks = { spec: "asks to spec task 12", develop: "asks to build task 12" };
    for (const [name, ask] of Object.entries(asks)) {
      expect(frontmatter(skill(name))).toMatchObject({
        description: expect.stringContaining(ask),
      });
    }
  });

  // Claude Code swaps $ARGUMENTS for what the developer typed. Other
  // harnesses would show it as it is, so the skills never use it.
  test("never rely on $ARGUMENTS, and name the task the developer gave", () => {
    for (const name of ["spec", "develop"]) {
      const text = skill(name).replaceAll(/\s+/g, " ");
      expect(text).not.toContain("$ARGUMENTS");
      expect(text).toContain("the task the developer named, such as 12");
    }
  });

  // Claude Code starts each shell command fresh. Other harnesses may too,
  // so the skills don't say which one does.
  test("say that the harness may start each shell command fresh", () => {
    for (const name of ["spec", "develop"]) {
      const text = skill(name).replaceAll(/\s+/g, " ");
      expect(text).not.toContain("Each shell command starts fresh");
      expect(text).toContain("Your harness may start each shell command fresh");
    }
  });

  test("use only the CLI commands the spec gives the skills", () => {
    for (const one of defaultSkills) {
      const used = [...one.text.matchAll(/skelcrew ([a-z-]+)/g)].map((match) => match[1] ?? "");
      for (const command of used) expect(skillCommands).toContain(command);
    }
  });

  // The skills' method came from an earlier Skelcrew, whose tool worked
  // differently. An agent told to run one of these would fail, or do what
  // Skelcrew now does itself: agents here never push, open pull requests or
  // keep their own record. Add to this list when another old word turns up.
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
    ];
    for (const one of defaultSkills) {
      const text = one.text.replaceAll(/\s+/g, " ");
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

  test("the develop skill claims the task, reports done, and can give up", () => {
    const text = skill("develop");
    expect(text).toContain("skelcrew claim");
    expect(text).toContain("skelcrew done");
    expect(text).toContain("skelcrew give-up");
  });

  // Only the developer starts a task. Claude must not start one because
  // the conversation seemed to call for it.
  test("only the developer can start them", () => {
    for (const name of ["spec", "develop"]) {
      expect(frontmatter(skill(name))).toMatchObject({ "disable-model-invocation": true });
    }
  });

  test("ask for a task number instead of claiming nothing", () => {
    for (const name of ["spec", "develop"]) {
      expect(skill(name)).toContain(
        "If you weren't given a task number, ask the developer which task, and wait.",
      );
    }
  });

  // Started without a number, $ARGUMENTS is empty, so "skelcrew claim
  // $ARGUMENTS" would read as a claim of nothing. The skill names the
  // number the developer gave instead.
  test("claim the task number the developer gave", () => {
    for (const name of ["spec", "develop"]) {
      const text = skill(name).replaceAll(/\s+/g, " ");
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
      spec: ["SKELCREW_SESSION=<session> skelcrew submit 12 --file spec.json"],
      develop: [
        "SKELCREW_SESSION=<session> skelcrew done 12",
        'SKELCREW_SESSION=<session> skelcrew give-up 12 "<reason>"',
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

  // The claim's answer doesn't name a worktree yet, so the skill can't
  // promise one.
  test("the develop skill stops if the claim doesn't say where to work", () => {
    const text = skill("develop").replaceAll(/\s+/g, " ");
    expect(text).not.toContain("The claim tells you the worktree");
    expect(text).toContain("If it doesn't, stop and tell the developer.");
  });

  // These files decide what an agent may do: which checks run, whether a
  // spec needs approval, which paths are critical, what Claude Code asks
  // about, and what the skills say. An agent that edits them changes its
  // own rules.
  test("never edit the files that set the rules", () => {
    for (const name of ["spec", "develop"]) {
      const text = skill(name).replaceAll(/\s+/g, " ");
      expect(text).toContain("Never edit `.skelcrew/workflow.yml`");
      expect(text).toContain("`.claude/settings.json`");
      expect(text).toContain("`.agents/skills/`");
      expect(text).not.toContain("`.claude/skills/`");
      expect(text).not.toContain("edit the checks");
    }
  });

  // The CLI isn't built yet, so the skill can't name its flags. Its help
  // says how the spec is passed.
  test("the spec skill reads how to pass the spec before submitting", () => {
    expect(skill("spec")).toContain("skelcrew submit --help");
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
    const text = skill("spec").replaceAll(/\s+/g, " ");
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
    expect(text.replaceAll(/\s+/g, " ")).toContain("run the command or read the line");
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
    for (const name of ["spec", "develop"]) {
      const text = skill(name).replaceAll(/\s+/g, " ");
      expect(text).toContain(
        "If a call is refused because the task was blocked or dropped, stop at once.",
      );
      expect(text).not.toContain("let go");
    }
  });
});
