// Skelcrew's own Pi login, which no sandbox sees, and each Pi agent's copy of it: read under Pi's
// lock, copied without refresh tokens, and renewed outside the sandbox with Pi's own command.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { rewriteCopies, writeCopy } from "./login-copies.ts";

// Skelcrew's own Pi folder, where sc install's pi auth login saves the login. A caller that was
// handed an environment passes its HOME, as for dataDir.
export const piHome = (home = homedir()) => join(dataDir(home), "pi");

// What Pi keeps in auth.json: a credential per provider, an API key or a sign-in's tokens and
// when they expire. Whatever else it keeps goes into each copy as it is.
const Login = z.record(
  z.string(),
  z.looseObject({ type: z.string(), expires: z.number().optional() }),
);
type Login = z.infer<typeof Login>;

const minute = 60_000;

// Waits for Pi's lock on the login and takes it, the way Pi does: a folder named after the
// file's real path and .lock, made with mkdir. A pi holding it keeps its time fresh, and one
// older than 30 seconds was left by a pi that stopped, so it is taken over.
async function locked<T>(file: string, read: () => T): Promise<T> {
  const lock = `${realpathSync(file)}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      const time = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (time !== undefined && time < Date.now() - 30_000)
        rmSync(lock, { recursive: true, force: true });
      else if (tries >= 600) throw error;
      else await Bun.sleep(50);
    }
  }
  try {
    return read();
  } finally {
    rmdirSync(lock);
  }
}

// Returns Skelcrew's own login, read under Pi's lock, or null when it has none.
async function readOwn(home: string): Promise<Login | null> {
  const file = join(piHome(home), "auth.json");
  if (!existsSync(file)) return null;
  const text = await locked(file, () => readFileSync(file, "utf8"));
  try {
    return Login.parse(JSON.parse(text));
  } catch {
    throw new Error(`${file} isn't a Pi login, so Skelcrew can't give agents a copy of it`);
  }
}

// Returns an agent's copy of a login, as Pi writes auth.json: all of it but each sign-in's
// refresh token, so only Skelcrew renews it.
const copyText = (login: Login) => {
  const copy = Object.fromEntries(
    Object.entries(login).map(([provider, given]) => [
      provider,
      given.type === "oauth" ? { ...given, refresh: "" } : given,
    ]),
  );
  return JSON.stringify(copy, null, 2);
};

// Returns whether Skelcrew has a Pi login of its own.
export const hasPiLogin = (home: string) => existsSync(join(piHome(home), "auth.json"));

// Writes the agent's own copy of Skelcrew's login in `folder`, renewing the login first when it
// is due. Returns false and writes nothing when Skelcrew has no login.
export async function copyPiLogin(home: string, folder: string): Promise<boolean> {
  await renewPiLogin(home);
  const own = await readOwn(home);
  if (own === null) return false;
  writeCopy(folder, copyText(own));
  return true;
}

// The renewal under way, which every caller waits on, so each refresh token is spent once.
let renewing: Promise<void> | null = null;
// When the last renewal failed. The next waits two minutes.
let failedAt = 0;

// Renews each sign-in in Skelcrew's login that ends within 20 minutes, outside the sandbox, with
// pi auth print-bearer-token, which takes Pi's lock and saves the renewal. Then writes the
// renewal into every agent's copy. A pi in the sandbox tries to renew its copy itself 5
// minutes before it ends, and can't, so the gap leaves several tries. A renewal that fails is
// logged without Pi's words, which could hold a token, and the login stays as it was.
export function renewPiLogin(home: string): Promise<void> {
  renewing ??= renewNow(home).finally(() => {
    renewing = null;
  });
  return renewing;
}

async function renewNow(home: string): Promise<void> {
  const now = Date.now();
  if (now - failedAt < 2 * minute) return;
  const own = await readOwn(home);
  const due = Object.entries(own ?? {}).filter(
    ([, given]) => given.type === "oauth" && (given.expires ?? 0) < now + 20 * minute,
  );
  if (due.length === 0) return;
  for (const [provider] of due) {
    const renewal = Bun.spawn(
      ["pi", "auth", "print-bearer-token", "--provider", provider, "--min-expiry", "20m"],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: piHome(home) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 60_000,
      },
    );
    if ((await renewal.exited) !== 0) {
      failedAt = now;
      console.log(
        `couldn't renew Skelcrew's Pi sign-in to ${provider}: pi exited with ${renewal.exitCode}`,
      );
    }
  }
  const renewed = await readOwn(home);
  if (renewed !== null) rewriteCopies(home, "pi", copyText(renewed));
}
