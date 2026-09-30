// The default skills `skelcrew init` writes into a repository. The text
// lives in skills/, as the Markdown files themselves, so they read and
// review like any other skill. Importing them as text builds them into
// Skelcrew, so init never has to find them on disk.

import approve from "./skills/approve/SKILL.md" with { type: "text" };
import crew from "./skills/crew/SKILL.md" with { type: "text" };
import develop from "./skills/develop/SKILL.md" with { type: "text" };
import idea from "./skills/idea/SKILL.md" with { type: "text" };
import reject from "./skills/reject/SKILL.md" with { type: "text" };
import show from "./skills/show/SKILL.md" with { type: "text" };
import spec from "./skills/spec/SKILL.md" with { type: "text" };

// Where the skill goes, relative to the repository, and what it says. The
// skills live in .agents/skills, so no one harness owns them.
export type Skill = { path: string; text: string };

// An agent works a task with spec and develop. The developer uses the
// others for their own verbs: add an idea, see what the crew is doing,
// show one task, approve it, or send it back.
export const defaultSkills: Skill[] = [
  { path: ".agents/skills/spec/SKILL.md", text: spec },
  { path: ".agents/skills/develop/SKILL.md", text: develop },
  { path: ".agents/skills/idea/SKILL.md", text: idea },
  { path: ".agents/skills/crew/SKILL.md", text: crew },
  { path: ".agents/skills/show/SKILL.md", text: show },
  { path: ".agents/skills/approve/SKILL.md", text: approve },
  { path: ".agents/skills/reject/SKILL.md", text: reject },
];
