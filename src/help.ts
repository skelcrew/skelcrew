// skel's help page: what skel --help shows, laid out in sections with skel.run's amber for
// the headings, so it reads as help and not as an error.

const sections: [string, [string, string][]][] = [
  [
    "COMMANDS",
    [
      ["(no command)", "Open this repository's lead, with the sidebar"],
      ["ps [<repo>]", "Threads and whether they need you"],
      ["task ls [<repo>]", "Open tasks, with the thread on each"],
      ["task show <task>", "A task's title and body"],
      ['task create <repo> "<title>" "<body>"', "Create a task, as a GitHub issue"],
      ["start <task> [--from <branch>]", "Start, resume, or go on past the limit"],
      ["stop <task>", "End the builder, keeping its clone and PR"],
      ["attach <task>", "Open that builder, with the sidebar"],
      ["review <task>", "Run the thread's last review again"],
    ],
  ],
  [
    "REPOSITORIES",
    [
      ["repo ls", "Repositories skel works on"],
      ["repo rm <name>", "Remove skel's clone of one"],
      ["repo trust <name>", "Trust one your login can't push to"],
    ],
  ],
  [
    "ELSEWHERE",
    [
      ["remote add <host>", "Set up a server, over ssh"],
      ["remote add sprite:<name>", "Set up a Sprite"],
      ["--remote <host> [command]", "Run skel on a server, over ssh"],
      ["--remote sprite:<name> [command]", "Run skel on a Sprite"],
      ["serve", "Run the daemon, for systemd or launchd"],
    ],
  ],
  [
    "FOR AGENTS",
    [
      ['submit "<summary>"', "Hand in a round for review, as a builder"],
      ['tell lead "<text>"', "Type a message into its repository's lead, as a builder"],
      ['tell <task> "<text>"', "Type a message into its builder, as the lead"],
    ],
  ],
  [
    "OPTIONS",
    [
      ["--json", "Output for tools"],
      ["--all", "Done threads too, on ps"],
      ["--from <owner/repo>", "The repository you're in"],
      ["--version", "Which release of skel this is"],
    ],
  ],
];

const examples = [
  "skel",
  'skel task create app "Fix the login redirect" "Sign-in lands on a 404."',
  "skel start app-12",
  "skel ps",
  "skel remote add sprite:demo",
  "skel --remote sprite:demo",
];

// Returns the help page, in color only for a terminal that shows it: piped into a file or
// a program, the codes would be noise.
export function help(color = colorful()): string {
  const paint = (codes: string) => (text: string) =>
    color ? `\x1b[${codes}m${text}\x1b[0m` : text;
  const heading = paint("1;38;2;240;166;58");
  const strong = paint("1");
  const dim = paint("2");
  const rows = sections.flatMap(([, list]) => list);
  const width = Math.max(...rows.map(([command]) => command.length)) + 3;
  const lines = [
    "",
    "  Claude Code, but always on, in parallel, isolated, and seeing each task",
    "  through to the merge.",
    "",
    heading("USAGE"),
    `  ${dim("%")} skel ${dim("[command] [options]")}`,
  ];
  for (const [title, list] of sections) {
    lines.push("", heading(title));
    for (const [command, what] of list) lines.push(`  ${strong(command.padEnd(width))}${what}`);
  }
  lines.push("", heading("EXAMPLES"), ...examples.map((example) => `  ${dim("%")} ${example}`));
  lines.push(
    "",
    dim("  A task is named by its repository and number, such as app-12. --remote keeps"),
    dim("  skel on the other side up to date with yours, after asking. See skel.run."),
    dim("  In the sidebar, click a row or press Alt-Up or Alt-Down. Alt-Shift-Up and"),
    dim("  Alt-Shift-Down jump between lists. Ctrl-Q leaves."),
    "",
  );
  return lines.join("\n");
}

// Returns whether stdout is a terminal that shows color, honoring NO_COLOR.
function colorful(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}
