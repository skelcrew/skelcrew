// Runs a short program outside your terminal and reads what it printed, for git, gh, ssh and
// sprite commands. remote.ts uses it on your laptop, so it loads nothing else of skel.

// What `quietly` can change about a run. No `env` hands on the environment skel started
// with, which leaves out any later change to process.env, so a command that needs those
// passes `env: process.env`.
type Options = {
  env?: Record<string, string | undefined>;
  stdin?: Blob;
  stdout?: "ignore";
  stderr?: "ignore";
};

// Runs a program, waits for it to end and returns its output, kept apart in `out` and `err`
// and together in `said`, and whether it succeeded. It never throws on a failed program, as
// each caller has its own words for that. A program gets no input unless handed `stdin`,
// and an output set to "ignore" comes back empty.
export async function quietly(argv: string[], options: Options = {}) {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...options });
  // Both outputs are read while the program runs: one that fills a pipe nobody reads never ends.
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, said: `${out}${err}`.trim(), ok: code === 0 };
}
