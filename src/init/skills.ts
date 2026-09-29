// The default skills `skelcrew init` writes into a repository. The text
// lives in skills/, as the Markdown files themselves, so they read and
// review like any other skill. Importing them as text builds them into
// Skelcrew, so init never has to find them on disk.

import develop from "./skills/develop/SKILL.md" with { type: "text" };
import spec from "./skills/spec/SKILL.md" with { type: "text" };

// Where the skill goes, relative to the repository, and what it says. The
// skills live in .agents/skills, so no one harness owns them.
export type Skill = { path: string; text: string };

export const defaultSkills: Skill[] = [
  { path: ".agents/skills/spec/SKILL.md", text: spec },
  { path: ".agents/skills/develop/SKILL.md", text: develop },
];
