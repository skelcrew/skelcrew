// Skelcrew as one file, built with bun build --compile as sc --remote builds it for a server:
// it runs, installs its daemon's service, and agents can run it in their sandbox.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";
let skel = "";

// Builds a program as one file, as sc --remote does, but for this machine, so the test can
// run it.
function compile(entry: string, file: string, stamp: string[] = []): void {
  const argv = [process.execPath, "build", "--compile", ...stamp, entry, "--outfile", file];
  const built = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
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
  skel = join(home, ".local", "bin", "sc");
  compile(source("main.ts"), skel);
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[], file = skel, typed = "") {
  const proc = Bun.spawn([file, ...args], {
    cwd: home,
    env: {
      PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
    },
    stdin: new Blob([typed]),
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
  expect(listed.out).toBe("Skelcrew has no repositories yet. Run sc in a checkout of one.\n");
});

test("runs a plugin's bun commands on the Bun inside it", async () => {
  // No bun on the PATH, so only Skelcrew itself can run the build.
  const folder = join(home, "skel-plugin-fake");
  mkdirSync(folder);
  writeFileSync(
    join(folder, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.4.0\nabout: x\njobs: [tracker]\nbuild: [[bun, build.ts]]\ncall: [bun, call.ts]\n",
  );
  writeFileSync(
    join(folder, "build.ts"),
    'await Bun.write("built", process.env.SKELCREW_PLUGIN ?? "");\n',
  );
  const installed = await run(["plugin", "install", folder], skel, "y\n");
  expect(installed.err).toBe("");
  expect(readFileSync(join(folder, "built"), "utf8")).toBe("fake");
  expect((await run(["plugin", "ls"])).out).toBe("fake 0.1.0 tracker\n");
});

test("points the daemon's service at itself", async () => {
  // As the first run leaves a machine, with a service Skelcrew then brings up to date.
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  const unit = join(home, ".config", "systemd", "user", "skelcrew.service");
  mkdirSync(join(unit, ".."), { recursive: true });
  writeFileSync(unit, "");
  fake("systemctl", 'test "$2" = daemon-reload');
  await run([]);
  expect(readFileSync(unit, "utf8")).toContain(`ExecStart="${skel}" serve\n`);
});

test("says which release it is, or which commit a build from a checkout came from", () => {
  const main = source("main.ts");
  const said = (build: string) => {
    const file = join(home, "stamped", build, "skel");
    compile(main, file, ["--define", `SKELCREW_BUILD=${JSON.stringify(build)}`]);
    return Bun.spawnSync([file, "--version"]).stdout.toString();
  };
  expect(said("0.4.2")).toBe("skelcrew 0.4.2\n");
  expect(said("39939b0")).toBe("skelcrew from a checkout, at commit 39939b0\n");
  expect(said("39939b0-dirty")).toBe(
    "skelcrew from a checkout, at commit 39939b0 with uncommitted changes\n",
  );
});

test("a build nobody stamped doesn't pretend to know what it is", () => {
  expect(Bun.spawnSync([skel, "--version"]).stdout.toString()).toBe(
    "skelcrew from a checkout, at an unknown commit\n",
  );
});

test("the sidebar's header shows the release of the Skelcrew that runs it", async () => {
  const file = join(home, "released", "skel");
  const main = source("main.ts");
  compile(main, file, ["--define", 'SKELCREW_BUILD="0.4.2"']);
  const agents = `skel-compiled-test-${process.pid}`;
  const tmux = (...args: string[]) =>
    Bun.spawnSync(["tmux", "-L", `${agents}-screen`, "-f", "/dev/null", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    tmux("new-session", "-d", "-s", "one", "-x", "120", "-y", "30", "sleep 60");
    const env = `env HOME=${home} XDG_RUNTIME_DIR=${join(home, "run")}`;
    tmux(
      "split-window",
      "-b",
      "-h",
      "-t",
      "=one:",
      `${env} ${file} sidebar ${agents} one '' simon/app`,
    );
    const header = () => tmux("show", "-v", "-t", "=one:", "status-format[0]").stdout.toString();
    for (let tries = 0; tries < 100 && !header().includes("Skelcrew"); tries++)
      await Bun.sleep(100);
    expect(header()).toContain(" 0.4.2");
  } finally {
    tmux("kill-server");
  }
});

test("the screen's panes run the single file itself, with no checkout to find", () => {
  const entry = join(home, "panes.ts");
  const screen = JSON.stringify(source("screen/screen.ts"));
  writeFileSync(
    entry,
    `import { pageCommand } from ${screen};\nconsole.log(JSON.stringify(pageCommand("url", "")));`,
  );
  const file = join(home, "panes", "skel");
  compile(entry, file);
  const said = Bun.spawnSync([file]).stdout.toString();
  expect(JSON.parse(said)).toEqual([file, "page", "url", ""]);
});

describe("a release setting up a server", () => {
  let files = new Map<string, string>();
  let server: ReturnType<typeof Bun.serve>;
  let released = "";
  const linux = "the Linux Skelcrew of 0.4.2";
  const sum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  // ssh to a server that has no Skelcrew until scp brings one.
  const newServer =
    'case "$*" in *first-run*) test -f "$HOME/copied" || exit 127;; *uname*) cat "$HOME/cpu"; echo "** WARNING: this ssh is old" >&2;; esac';

  // Stands in for a new server: it has no Skelcrew until scp brings one.
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const file = files.get(new URL(request.url).pathname);
        return file === undefined ? new Response("no", { status: 404 }) : new Response(file);
      },
    });
    released = join(home, "from-release", "skel");
    const main = source("main.ts");
    compile(main, released, [
      "--define",
      'SKELCREW_BUILD="0.4.2"',
      "--define",
      `SKELCREW_RELEASES="http://127.0.0.1:${server.port}"`,
    ]);
    fake("ssh", newServer);
    fake("scp", 'for word; do test -f "$word" && cp "$word" "$HOME/copied"; done; exit 0');
  });
  afterAll(() => {
    server.stop(true);
  });
  beforeEach(() => {
    rmSync(join(home, "copied"), { force: true });
    writeFileSync(join(home, "cpu"), "x86_64\n");
    files = new Map([
      ["/download/v0.4.2/skelcrew-linux-x64", linux],
      [
        "/download/v0.4.2/SHA256SUMS",
        `${sum("other")}  skelcrew-darwin-arm64\n${sum(linux)}  skelcrew-linux-x64\n`,
      ],
    ]);
  });

  test("copies over the Linux binary of its own release", async () => {
    const done = await run(["remote", "add", "simon@workbox"], released);
    expect(done.err).toBe("");
    expect(done.code).toBe(0);
    expect(readFileSync(join(home, "copied"), "utf8")).toBe(linux);
    expect(done.out).toContain("sc --remote simon@workbox");
  });

  test("a single file that is no release says it can't build a copy", async () => {
    const done = await run(["remote", "add", "simon@workbox"]);
    expect(done.code).toBe(1);
    expect(done.err).toContain("can't build one");
    expect(existsSync(join(home, "copied"))).toBe(false);
  });

  test("copies the binary for the server's CPU, which can differ from the laptop's", async () => {
    const arm = "the arm64 Linux Skelcrew of 0.4.2";
    files.set("/download/v0.4.2/skelcrew-linux-arm64", arm);
    files.set("/download/v0.4.2/SHA256SUMS", `${sum(arm)}  skelcrew-linux-arm64\n`);
    writeFileSync(join(home, "cpu"), "aarch64\n");
    const done = await run(["remote", "add", "simon@workbox"], released);
    expect(done.err).toBe("");
    expect(readFileSync(join(home, "copied"), "utf8")).toBe(arm);
  });

  test("says so when the server has a CPU Skelcrew isn't built for", async () => {
    writeFileSync(join(home, "cpu"), "riscv64\n");
    const done = await run(["remote", "add", "simon@workbox"], released);
    expect(done.code).toBe(1);
    expect(done.err).toContain("riscv64");
    expect(existsSync(join(home, "copied"))).toBe(false);
  });

  test("copies nothing that fails its checksum", async () => {
    files.set("/download/v0.4.2/skelcrew-linux-x64", "tampered");
    const done = await run(["remote", "add", "simon@workbox"], released);
    expect(done.code).toBe(1);
    expect(done.err).toContain("checksum");
    expect(existsSync(join(home, "copied"))).toBe(false);
  });

  test("--remote keeps a server at the laptop's release, after asking", async () => {
    // A server on 0.4.1, which says so to a laptop on another release, as Skelcrew there does.
    fake(
      "ssh",
      `case "$*" in
  *SKELCREW_LAPTOP_BUILD=0.4.2*) test -f "$HOME/copied" || { echo "Skelcrew on simon@workbox is from 0.4.1."; exit 98; };;
  *readlink*) echo copied;;
  *uname*) cat "$HOME/cpu";;
esac
exit 0`,
    );
    try {
      const done = await run(["--remote", "simon@workbox", "ps"], released);
      expect(done.err).toBe("");
      expect(done.code).toBe(0);
      expect(readFileSync(join(home, "copied"), "utf8")).toBe(linux);
      expect(readFileSync(join(home, "calls"), "utf8")).toContain(
        "ssh simon@workbox systemctl --user restart skelcrew\n",
      );
      expect(done.out).toContain(
        "updated simon@workbox to Skelcrew 0.4.2 and restarted its daemon",
      );
    } finally {
      fake("ssh", newServer);
    }
  });

  test("names the address when the download fails", async () => {
    files.delete("/download/v0.4.2/skelcrew-linux-x64");
    const done = await run(["remote", "add", "simon@workbox"], released);
    expect(done.code).toBe(1);
    expect(done.err).toContain(
      `http://127.0.0.1:${server.port}/download/v0.4.2/skelcrew-linux-x64`,
    );
  });
});

describe.skipIf(process.env.SKELCREW_SANDBOX === "1")("in the sandbox", () => {
  test("agents run sc itself", async () => {
    // A program built like Skelcrew that starts a sandbox and runs itself in it, standing in
    // for the daemon starting an agent that runs Skelcrew.
    const entry = join(home, "agent.ts");
    writeFileSync(
      entry,
      `import { sandboxArgs } from ${JSON.stringify(source("agents/sandbox.ts"))};
if (process.argv[2] === "inside") {
  console.log("Skelcrew ran in the sandbox");
} else {
  const argv = sandboxArgs({ home: ${JSON.stringify(home)}, path: "/usr/bin:/bin", mounts: [],
    cwd: "/", command: ["sh", "-c", "command -v sc && sc inside"] });
  const done = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  process.exit(done.exitCode);
}`,
    );
    const agent = join(home, "agent", "sc");
    compile(entry, agent);
    const done = Bun.spawnSync([agent], { stdout: "pipe", stderr: "pipe" });
    expect(done.stderr.toString()).toBe("");
    expect(done.stdout.toString()).toBe(`${agent}\nSkelcrew ran in the sandbox\n`);
  });
});
