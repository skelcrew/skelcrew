// Skelcrew's help page: what sc --help shows, laid out in sections with skelcrew.dev's amber for
// the headings, so it reads as help and not as an error.

// The help page's sections, each a heading and its rows of a command and what it does.
const sections: [string, [string, string][]][] = [
  [
    "COMMANDS",
    [
      ["(no command)", "Open this repository's lead, with the sidebar"],
      ["ps [<repo>]", "Threads and whether they need you"],
      ["start <issue> [--from <branch>]", "Start, resume, or go on past the limit"],
      ['start <repo> "<title>" "<body>"', "Start a thread, with no issue in the tracker"],
      ["start <repo> < <file>", "The same, with the title on stdin's first line"],
      ["stop <thread>", "End the builder, keeping its clone and PR"],
      ['rm <thread> ["<reason>"]', "Close its PR, delete its branch and clone"],
      ["attach <thread>", "Open that builder, with the sidebar"],
      ["review <thread>", "Run the thread's last review again"],
    ],
  ],
  [
    "ISSUES",
    [
      ["issue ls [<repo>]", "Open issues, with the thread on each"],
      ["issue show <issue>", "An issue's title and body"],
      ['issue create <repo> "<title>" "<body>"', "Create an issue in the repository's tracker"],
    ],
  ],
  [
    "REPOSITORIES",
    [
      ["init", "Write a starter skelcrew.yaml here and add this repository"],
      ["repo add [<path> | <url> | <owner/repo>]", "Add a repository, this one by default"],
      ["repo ls", "Repositories Skelcrew works on"],
      ["repo rm <name>", "Remove Skelcrew's clone of one"],
      ["repo trust <name>", "Trust one your login can't push to"],
    ],
  ],
  [
    "PLUGINS",
    [
      ["plugin install <owner/repo> | <path>", "Install a plugin, after asking"],
      ["plugin update [<name>]", "Move one, or all, to its newest version"],
      ["plugin setup <name>", "Run its setup again, such as to sign in again"],
      ["plugin rm <name>", "Remove one, with its settings and tokens"],
      ["plugin ls", "Plugins installed, with their jobs"],
    ],
  ],
  [
    "ELSEWHERE",
    [
      ["remote add <host>", "Set up a server, over ssh"],
      ["remote add sprite:<name>", "Set up a Sprite"],
      ["--remote <host> [command]", "Run sc on a server, over ssh"],
      ["--remote sprite:<name> [command]", "Run sc on a Sprite"],
      ["serve", "Run the daemon, for systemd or launchd"],
    ],
  ],
  [
    "FOR AGENTS",
    [
      ['submit "<summary>"', "Hand in a round for review, as a builder"],
      ['tell lead "<text>"', "Type a message into its repository's lead, as a builder"],
      ['tell <thread> "<text>"', "Type a message into its builder, as the lead"],
    ],
  ],
  [
    "OPTIONS",
    [
      ["--json", "Output for tools"],
      ["--all", "Done threads too, on ps"],
      ["--from <remote>", "The repository you're in"],
      ["--version", "Which release of Skelcrew this is"],
    ],
  ],
];

// Lines to copy, in the order a new user would run them.
const examples = [
  "sc",
  'sc issue create app "Fix the login redirect" "Sign-in lands on a 404."',
  "sc start app-12",
  "sc ps",
  "sc remote add sprite:demo",
  "sc --remote sprite:demo",
];

// Returns the help page, in color only for a terminal that shows it: piped into a file or
// a program, the codes would be noise.
export function help(color = colorful()): string {
  const paint = (codes: string) => (text: string) =>
    color ? `\x1b[${codes}m${text}\x1b[0m` : text;
  // Headings in skelcrew.dev's amber, bold.
  const heading = paint("1;38;2;240;166;58");
  const strong = paint("1");
  const dim = paint("2");
  // Every section's commands line up in one column, as wide as the longest and three more.
  const rows = sections.flatMap(([, list]) => list);
  const width = Math.max(...rows.map(([command]) => command.length)) + 3;
  const lines = [
    "",
    "  A crew of coding agents, always on, in parallel and isolated, from issue to",
    "  merged PR. Bring your own harness and model.",
    "",
    heading("USAGE"),
    `  ${dim("%")} sc ${dim("[command] [options]")}`,
  ];
  for (const [title, list] of sections) {
    lines.push("", heading(title));
    for (const [command, what] of list) lines.push(`  ${strong(command.padEnd(width))}${what}`);
  }
  lines.push("", heading("EXAMPLES"), ...examples.map((example) => `  ${dim("%")} ${example}`));
  lines.push(
    "",
    dim("  A thread is named after its issue, such as app-12. --remote keeps"),
    dim("  Skelcrew on the other side up to date with yours, after asking. See skelcrew.dev."),
    dim("  In the sidebar, click a row or press Alt-Up or Alt-Down. Alt-Shift-Up and"),
    dim("  Alt-Shift-Down jump between lists. Alt-Left and Alt-Right, or Alt-Shift-Left"),
    dim("  and Alt-Shift-Right, switch to the repository before or after. Ctrl-Q leaves."),
    "",
  );
  return lines.join("\n");
}

// Returns whether stdout is a terminal that shows color, honoring NO_COLOR.
function colorful(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}
