// Reads what a command was given: the names of tasks and threads among its arguments, a task's
// title and body on stdin, and the human's words in a file. Says so when a command can't run
// as given.

export function splitTaskName(word?: string): [string, string] | undefined {
  const parts = word?.match(/^(.+)-([a-z]{0,2}\d+)$/i);
  return parts?.[1] && parts[2] ? [parts[1], parts[2].toLowerCase()] : undefined;
}

export function splitThreadName(word?: string): [string, string] | undefined {
  const parts = word?.match(/^(.+)\/([a-z]+)$/i);
  const task = splitTaskName(parts?.[1] ?? word);
  if (task && parts?.[2] && parts[2].toLowerCase() !== "builder")
    throw new Error(`${parts[1]} has no ${parts[2]} thread: a task's only thread is its builder`);
  return task;
}

export function parseTask(text: string, command: string): { title: string; body: string } {
  const [first = "", ...rest] = text.split("\n");
  const title = first.replace(/^#\s+/, "").trim();
  const body = rest.join("\n").replace(/^(?:[ \t]*\n)+/, "");
  if (!title)
    throw new Error(
      `${command} read no title on stdin: give the title on the first line, then the body`,
    );
  if (!body.trim())
    throw new Error(
      `${command} read a title but no body on stdin: give the body on the lines after the title`,
    );
  return { title, body };
}

export function bodyFor(command: string, body: string): string {
  if (!body.trim())
    throw new Error(`${command} needs a body, which is all a builder sees besides its title.`);
  return body;
}

export async function readAsked(file: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const words = readFileSync(file, "utf8");
  if (!words.trim())
    throw new Error(`${file} is empty: write the human's words in it, exactly as they wrote them`);
  return words;
}

const commands = [
  "serve",
  "restart",
  "init",
  "repo",
  "ps",
  "ls",
  "show",
  "task",
  "start",
  "stop",
  "rm",
  "merge",
  "attach",
  "peek",
  "interrupt",
  "needs-you",
  "ask",
  "review",
  "submit",
  "hook",
  "check",
  "tell",
  "install",
  "add",
  "remove",
  "update",
  "setup",
  "plugins",
  "plugin",
];

function usageMessage(command: string): string {
  if (command === "--remote") return "--remote needs a host, such as sc --remote simon@workbox.";
  if (command === "remote")
    return "sc remote add is now sc --remote <host> install, such as sc --remote simon@workbox install.";
  if (command === "issue" || command === "pr")
    return 'issues and PRs are parts of tasks now: sc ls lists them, sc show <task> shows one with its PR, and sc task add <repo> "<title>" "<body>" --issue opens an issue.';
  if (commands.includes(command))
    return `sc ${command} was given arguments it doesn't take. Run sc --help to see how to use it.`;
  return "that isn't a Skelcrew command. Run sc --help to see them.";
}

export function usage(command?: string): never {
  console.error(`Skelcrew: ${usageMessage(command ?? "")}`);
  process.exit(1);
}
