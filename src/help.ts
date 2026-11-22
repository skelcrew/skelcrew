// Skelcrew's help page: what sc --help shows, laid out in sections with skelcrew.dev's amber for
// the headings, so it reads as help and not as an error.
import { colorful } from "./format.ts";

// The help page's sections, each a heading and its rows of a command and what it does.
const sections: [string, [string, string][]][] = [
  [
    "COMMANDS",
    [
      ["(no command)", "Open this repository's lead, with the sidebar"],
      ["--list", "This repository's list. ctrl+\\ comes back to it from an agent"],
      ["ls [<repo>]", "Tasks, with each one's stage, status, PR, CI and review"],
      ["show <task>", "A task: stage, description, threads, PR, checks, review"],
      ["ps [<repo>]", "Threads: status, PR, CI, review, needs you"],
      ["start <task> [--from <branch>]", "Start, resume, or go on past the limit"],
      ['add <repo> "<title>" "<body>"', "File a task in the backlog, or --start it now"],
      ["add <repo> < <file>", "The same, with the title on stdin's first line"],
      ["stop <task>", "End the builder, keeping its clone and PR"],
      ['rm <task> ["<reason>"]', "Close its PR and issue, delete its branch and clone"],
      ["attach <task>", "Open that builder full screen. ctrl+\\ detaches on tmux"],
      ["peek <task>", "What that builder shows now, without attaching"],
      ["interrupt <task>", "Stop that builder's turn, as Esc does"],
      ["review <task>", "Run the task's last review again"],
      ["merge --when-ready <task> | <#pr>", "Merge it once it is approved and green"],
      ["merge --skip-review <task> | <#pr>", "Merge it without Skelcrew's approval once CI passes"],
      ["merge --cancel <task> | <#pr>", "Stop a merge armed with either"],
    ],
  ],
  [
    "REPOSITORIES",
    [
      ["init", "Write skelcrew.yaml, skelcrew.lock and .agents/ here and add this repository"],
      ["repo add [<path> | <url> | <owner/repo>]", "Add a repository, this one by default"],
      ["repo ls", "Repositories Skelcrew works on"],
      ["repo rm <name>", "Remove Skelcrew's clone of one"],
      ["repo trust <name>", "Trust one your login can't push to, or approve its .agents/"],
    ],
  ],
  [
    "PLUGINS",
    [
      ["install", "Set up this machine and the plugins your files name, asking"],
      ["plugin add <owner/repo>", "Add a plugin to this repository, after asking"],
      ["plugin add -g <owner/repo> | <path>", "Add a plugin of your own, after asking"],
      ["plugin update -g [<name>]", "Move one, or all, to its newest version, after asking"],
      ["plugin setup <name>", "Run its setup again, such as to sign in again"],
      ["plugin rm -g <name>", "Remove one, with its settings and tokens"],
      ["plugin ls", "Your plugins, and what install would change"],
    ],
  ],
  [
    "ELSEWHERE",
    [
      ["--remote <host> install", "Send your personal files to a server, and set it up"],
      ["--remote <host> serve --bg", "Run the daemon on a server, in the background"],
      ["--remote <host> [command]", "Run sc on a server, over ssh"],
    ],
  ],
  [
    "THE DAEMON",
    [
      ["serve", "Run the daemon here, until Ctrl-C"],
      ["serve --bg", "Run it as a systemd or launchd service, and return"],
      ["restart", "Restart it, here or with --remote. Agents keep running"],
    ],
  ],
  [
    "FOR AGENTS",
    [
      ['submit "<summary>"', "Hand in a round for review, as a builder"],
      ["check", "Run the repository's tests once a check slot is free"],
      ['tell lead "<text>"', "Type a message into its repository's lead, as a builder"],
      ['tell <task> "<text>" | -', "Type a message into its builder, as the lead, - for stdin"],
      ['tell lead <repo> "<text>" | -', "Type a brief into another repository's lead, - for stdin"],
      ['ask <task> | <repo> "<text>"', "Ask the human in Needs you, with --option per choice"],
      ["ask --clear <task> | <repo>", "Take that item off Needs you"],
      ['decide <task> "<decision>"', "Record what is settled, as the lead, for every reviewer"],
      [
        'keep <task> "<property>" ...',
        "Set the 2 to 4 things the change must keep true, as the lead",
      ],
      [
        'notify --via <channel> "<subject>" "<text>"',
        "Send the human what they asked for, with --asked-file",
      ],
    ],
  ],
  [
    "OPTIONS",
    [
      ["--json", "Output for tools"],
      ["--all", "Done threads too, on ps, and ended tasks, on ls"],
      ["--start", "Start the task at once, not filing it, on add"],
      ['--short "<words>"', "A thread's short title for the sidebar, on start or --start"],
      ["--flow <name>", "The flow a task runs, from .agents/flows/, on start or --start"],
      ['--keep "<property>"', "One of 2 to 4 things it must keep true, on start or --start"],
      ["--now", "Start a task at once, over its repository's limits.threads"],
      ["--issue", "Open the task as an issue in the tracker too, on add"],
      ["--keep-issue", "Keep its issue open, to start it over, on rm"],
      ["--from <remote>", "The repository you're in"],
      ["--version", "Which release of Skelcrew this is"],
    ],
  ],
  // The screen's keys, in words, read as "alt + q to quit, agents run on". Ctrl + \ brings your
  // typing to the sidebar from anywhere, which a Mac needs, as there Option with a digit types a
  // character. Those that work anywhere come first, then those for the sidebar, where the list's
  // keys work without Alt. a does what shift + enter does, for a terminal that sends that as
  // plain Enter. Ctrl-Q leaves too, but isn't listed: it is there for a Mac terminal that doesn't
  // send Option as Alt. alt + w works anywhere, and w only in the sidebar.
  [
    "KEYS",
    [
      ["ctrl + \\", "type to the sidebar, from the lead or an agent"],
      ["alt + ↑/↓", "move one row"],
      ["alt + shift + ↑/↓", "jump to the next or previous section"],
      ["alt + 0-6", "open or close a stage"],
      ["alt + shift + ←/→", "switch repository"],
      ["alt + w, w", "close the repository's tab, or remove it from Skelcrew"],
      ["alt + q", "quit, agents run on"],
      ["↑/↓, 0-6", "in the sidebar: move, open or close a section"],
      ["enter", "open the row you are on: its item, its agent, or a stage"],
      ["shift + enter, a", "type to the row's agent full screen"],
      ["shift + ↑/↓", "move a queued task in the task queue"],
      ["s", "start or queue a task in the backlog"],
      ["f", "start a queued task now, over the limit"],
      ["m", "merge a ready task"],
      ["a-d, r", "answer the lead's item in Needs you, or type a reply"],
      ["y / n", "answer a question at the bottom, such as to merge"],
      ["shift + r", "restart the row's agent, keeping its conversation"],
    ],
  ],
];

// Lines to copy, in the order a new user would run them.
const examples = [
  "sc",
  'sc add app "Fix the login redirect" "Sign-in lands on a 404." --issue',
  "sc start app#12",
  "sc ls",
  "sc --remote simon@workbox install",
  "sc --remote simon@workbox",
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
    dim("  Every task is named by its repository and a number, such as APP-100, with"),
    dim("  its issue beside it, such as #12. An issue no task has yet is app#12. Type a"),
    dim("  name in any case: app-100 is APP-100. --remote keeps Skelcrew on the other"),
    dim("  side up to date with yours, after asking. See skelcrew.dev."),
    "",
  );
  return lines.join("\n");
}
