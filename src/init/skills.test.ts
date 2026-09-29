import { describe, expect, test } from "bun:test";
import { defaultSkills } from "./skills";

// The skills an agent in your harness uses to report. They are the
// commands the spec's CLI table marks "used by the skills", plus approve,
// which a skill names only to say that the developer runs it.
const skillCommands = ["claim", "submit", "done", "ask", "give-up", "approve"];

function frontmatter(text: string): unknown {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match?.[1] === undefined ? null : Bun.YAML.parse(match[1]);
}

function skill(name: string): string {
  return defaultSkills.find((one) => one.path === `.claude/skills/${name}/SKILL.md`)?.text ?? "";
}

describe("defaultSkills", () => {
  test("are the spec and develop skills, where Claude Code looks for them", () => {
    expect(defaultSkills.map((one) => one.path)).toEqual([
      ".claude/skills/spec/SKILL.md",
      ".claude/skills/develop/SKILL.md",
    ]);
  });

  test("each starts with a name and a description, as Claude Code skills do", () => {
    for (const name of ["spec", "develop"]) {
      const front = frontmatter(skill(name));
      expect(front).toMatchObject({ name, description: expect.any(String) });
    }
  });

  test("use only the CLI commands the spec gives the skills", () => {
    for (const one of defaultSkills) {
      const used = [...one.text.matchAll(/skelcrew ([a-z-]+)/g)].map((match) => match[1] ?? "");
      for (const command of used) expect(skillCommands).toContain(command);
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

  // These files decide what an agent may do: which checks run, whether a
  // spec needs approval, which paths are critical, what Claude Code asks
  // about, and what the skills say. An agent that edits them changes its
  // own rules.
  test("never edit the files that set the rules", () => {
    for (const name of ["spec", "develop"]) {
      const text = skill(name).replaceAll(/\s+/g, " ");
      expect(text).toContain("Never edit `.skelcrew/workflow.yml`");
      expect(text).toContain("`.claude/settings.json`");
      expect(text).toContain("`.claude/skills/`");
      expect(text).not.toContain("edit the checks");
    }
  });

  // The CLI isn't built yet, so the skill can't name its flags. Its help
  // says how the spec is passed.
  test("the spec skill reads how to pass the spec before submitting", () => {
    expect(skill("spec")).toContain("skelcrew submit --help");
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
