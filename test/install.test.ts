// The install script, run as curl | sh runs it, against a local server standing in for where
// releases live, with stand-ins for uname so one machine can act as any other.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "install.sh");
const assets = ["skel-darwin-arm64", "skel-darwin-x64", "skel-linux-arm64", "skel-linux-x64"];

// Returns a stand-in for a release binary, which says which one it is.
const binary = (name: string) => `#!/bin/sh\necho "skel 0.4.2 ($0 ${name})"\n`;
// Returns a file's SHA-256, as the release's checksums list it.
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let served = new Map<string, string>();
let asked: string[] = [];
let home = "";
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname.replace("/latest/download/", "");
      asked.push(name);
      const file = served.get(name);
      return file === undefined ? new Response("no", { status: 404 }) : new Response(file);
    },
  });
});
afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-install-test-")));
  mkdirSync(join(home, "fakes"));
  asked = [];
  served = new Map(assets.map((name) => [name, binary(name)]));
  const sums = assets.map((name) => `${sha256(binary(name))}  ${name}\n`).join("");
  served.set("SHA256SUMS", sums);
  machine("Linux", "x86_64");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Puts a stand-in program first on the PATH.
function fake(name: string, body: string): void {
  writeFileSync(join(home, "fakes", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Makes this test's machine one with the given system and CPU, as uname names them.
function machine(system: string, cpu: string): void {
  fake("uname", `case "$1" in -s) echo ${system};; -m) echo ${cpu};; esac`);
}

// Runs the script the way the install line does, fed to the shell through a pipe, and returns
// what it said. Not spawnSync, as the fake server runs in this process and must answer.
async function install(shell: string[], path = `${join(home, "fakes")}:/usr/bin:/bin`) {
  // By its full path, as a test's PATH can leave the shell out.
  const [name = "", ...flags] = shell;
  const proc = Bun.spawn([Bun.which(name) ?? name, ...flags], {
    cwd: home,
    env: {
      PATH: path,
      HOME: home,
      SKEL_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdin: new Blob([readFileSync(script, "utf8")]),
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

const installed = () => join(home, ".local", "bin", "skel");
const onPath = (shell: string[]) =>
  install(shell, `${join(home, ".local", "bin")}:${join(home, "fakes")}:/usr/bin:/bin`);

// macOS's sh is bash in POSIX mode, so that is the shell most installs will run under.
describe.each([[["sh"]], [["dash"]], [["bash", "--posix"]]])("under %j", (shell) => {
  test("installs the binary for this machine and says to run skel", async () => {
    const done = await onPath(shell);
    expect(done.err).not.toContain("skel:");
    expect(done.code).toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe(binary("skel-linux-x64"));
    expect(Bun.spawnSync([installed()]).success).toBe(true);
    expect(done.out).toContain("Run skel");
    expect(done.out).not.toContain("PATH");
  });

  test("picks the binary by system and CPU, whatever name the machine gives them", async () => {
    const machines = [
      ["Darwin", "arm64", "skel-darwin-arm64"],
      ["Darwin", "x86_64", "skel-darwin-x64"],
      ["Linux", "aarch64", "skel-linux-arm64"],
      ["Linux", "arm64", "skel-linux-arm64"],
      ["Linux", "x86_64", "skel-linux-x64"],
      ["Linux", "amd64", "skel-linux-x64"],
    ] as const;
    for (const [system, cpu, asset] of machines) {
      machine(system, cpu);
      const done = await install(shell);
      expect(done.code).toBe(0);
      expect(readFileSync(installed(), "utf8")).toBe(binary(asset));
    }
  });

  test("a terminal running through Rosetta on an Apple Silicon Mac gets the native binary", async () => {
    machine("Darwin", "x86_64");
    fake("sysctl", 'test "$2" = sysctl.proc_translated && echo 1');
    expect((await install(shell)).code).toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe(binary("skel-darwin-arm64"));
  });

  test("says how to reach skel when ~/.local/bin isn't on the PATH", async () => {
    const done = await install(shell);
    expect(done.code).toBe(0);
    expect(done.out).toContain("isn't on your PATH");
    expect(done.out).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(done.out).toContain("run skel");
  });

  test("a download that doesn't match its checksum installs nothing and keeps the old skel", async () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(installed(), "the old skel");
    served.set("skel-linux-x64", "tampered");
    const done = await install(shell);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("checksum");
    expect(readFileSync(installed(), "utf8")).toBe("the old skel");
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["skel"]);
  });

  test("a release with no checksum for this binary installs nothing", async () => {
    served.set("SHA256SUMS", "");
    const done = await install(shell);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("checksum");
    expect(existsSync(installed())).toBe(false);
  });

  test("a binary that can't start here installs nothing and keeps the old skel", async () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(installed(), "the old skel");
    const broken = "#!/bin/sh\nexit 1\n";
    served.set("skel-linux-x64", broken);
    served.set("SHA256SUMS", `${sha256(broken)}  skel-linux-x64\n`);
    const done = await install(shell);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("won't start");
    expect(readFileSync(installed(), "utf8")).toBe("the old skel");
  });

  test("a download that fails says which address failed", async () => {
    served.delete("skel-linux-x64");
    const done = await install(shell);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain(`http://127.0.0.1:${server.port}/latest/download/skel-linux-x64`);
    expect(existsSync(installed())).toBe(false);
    expect(readdirSync(join(home, ".local", "bin"))).toEqual([]);
  });

  test("Windows is refused with a clear message, before any download", async () => {
    for (const system of ["MINGW64_NT-10.0", "MSYS_NT-10.0", "CYGWIN_NT-10.0"]) {
      machine(system, "x86_64");
      const done = await install(shell);
      expect(done.code).not.toBe(0);
      expect(done.err).toContain("Windows");
    }
    expect(asked).toEqual([]);
  });

  test("a system or CPU skel isn't built for is named, before any download", async () => {
    machine("FreeBSD", "amd64");
    const system = await install(shell);
    expect(system.code).not.toBe(0);
    expect(system.err).toContain("FreeBSD");
    machine("Linux", "riscv64");
    const cpu = await install(shell);
    expect(cpu.code).not.toBe(0);
    expect(cpu.err).toContain("riscv64");
    expect(asked).toEqual([]);
  });

  test("Linux with musl, such as Alpine, is refused, as the binaries need glibc", async () => {
    fake("ldd", 'echo "musl libc (x86_64)" >&2\nexit 1');
    const done = await install(shell);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("glibc");
    expect(asked).toEqual([]);
  });

  test("works where only shasum can check a file, as on a Mac", async () => {
    const tools = ["awk", "chmod", "curl", "mkdir", "mktemp", "mv", "rm"];
    mkdirSync(join(home, "tools"));
    for (const tool of tools) {
      const found = Bun.which(tool);
      if (found === null) throw new Error(`this test needs ${tool}`);
      symlinkSync(found, join(home, "tools", tool));
    }
    const sum = Bun.which("sha256sum");
    fake("shasum", `test "$1 $2" = "-a 256" && shift 2 && exec ${sum} "$@"`);
    machine("Darwin", "arm64");
    const done = await install(shell, `${join(home, "fakes")}:${join(home, "tools")}`);
    expect(done.err).not.toContain("skel:");
    expect(done.code).toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe(binary("skel-darwin-arm64"));
  });

  test("says what is missing when curl isn't installed", async () => {
    mkdirSync(join(home, "bare"));
    const done = await install(shell, `${join(home, "fakes")}:${join(home, "bare")}`);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("curl");
  });

  test("replaces a link to a checkout's skel, and not the file it points to", async () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, "launcher"), "the checkout's launcher");
    chmodSync(join(home, "launcher"), 0o755);
    symlinkSync(join(home, "launcher"), installed());
    expect((await install(shell)).code).toBe(0);
    expect(readFileSync(join(home, "launcher"), "utf8")).toBe("the checkout's launcher");
    expect(readFileSync(installed(), "utf8")).toBe(binary("skel-linux-x64"));
  });

  test("a file only half received by the shell does nothing", async () => {
    const whole = readFileSync(script, "utf8");
    const half = Bun.spawn(shell, {
      cwd: home,
      env: { PATH: "/usr/bin:/bin", HOME: home },
      stdin: new Blob([whole.slice(0, whole.lastIndexOf("main"))]),
      stdout: "ignore",
      stderr: "ignore",
    });
    await half.exited;
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});
