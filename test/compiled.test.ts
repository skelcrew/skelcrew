// skel as one file, built with bun build --compile as skel --remote builds it for a server:
// it runs, installs its daemon's service, and agents can run it in their sandbox.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "";
let skel = "";

// Builds a program as one file, the way skel --remote does.
function compile(entry: string, file: string): void {
  const built = Bun.spawnSync(
    [process.execPath, "build", "--compile", "--target=bun-linux-x64", entry, "--outfile", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!built.success) throw new Error(built.stderr.toString());
}

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    {
      mode: 0o755,
    },
  );
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-compiled-test-")));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "run"), { mode: 0o700 });
  skel = join(home, ".local", "bin", "skel");
  compile(join(import.meta.dir, "..", "src", "main.ts"), skel);
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[]) {
  const proc = Bun.spawn([skel, ...args], {
    cwd: home,
    env: {
      PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
    },
    stdin: new Blob([""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

test("runs commands with its state", async () => {
  const listed = await run(["repo", "ls"]);
  expect(listed.err).toBe("");
  expect(listed.out).toBe(
    "skel has no repositories yet. Run skel in a checkout of one, or ask the lead for one by its GitHub name.\n",
  );
});

test("points the daemon's service at itself", async () => {
  // As the first run leaves a machine, with a service skel then brings up to date.
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(join(home, ".config", "skel", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skel", "claude-token"), "sk-ant-oat01-good\n");
  const unit = join(home, ".config", "systemd", "user", "skel.service");
  mkdirSync(join(unit, ".."), { recursive: true });
  writeFileSync(unit, "");
  fake("systemctl", 'test "$2" = daemon-reload');
  await run([]);
  expect(readFileSync(unit, "utf8")).toContain(`ExecStart="${skel}" serve\n`);
});

describe.skipIf(process.env.SKEL_SANDBOX === "1")("in the sandbox", () => {
  test("agents run skel itself", async () => {
    // A program built like skel that starts a sandbox and runs itself in it, standing in
    // for the daemon starting an agent that runs skel.
    const entry = join(home, "agent.ts");
    writeFileSync(
      entry,
      `import { sandboxArgs } from ${JSON.stringify(join(import.meta.dir, "..", "src", "sandbox.ts"))};
if (process.argv[2] === "inside") {
  console.log("skel ran in the sandbox");
} else {
  const argv = sandboxArgs({ home: ${JSON.stringify(home)}, path: "/usr/bin:/bin", mounts: [],
    cwd: "/", command: ["sh", "-c", "command -v skel && skel inside"] });
  const done = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  process.exit(done.exitCode);
}`,
    );
    const agent = join(home, "agent", "skel");
    compile(entry, agent);
    const done = Bun.spawnSync([agent], { stdout: "pipe", stderr: "pipe" });
    expect(done.stderr.toString()).toBe("");
    expect(done.stdout.toString()).toBe(`${agent}\nskel ran in the sandbox\n`);
  });
});
