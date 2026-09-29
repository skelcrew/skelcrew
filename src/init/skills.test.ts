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
});
