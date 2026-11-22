// Each Codex agent's own copy of Skelcrew's Codex login, written, renewed and removed outside
// the sandbox. A copy holds no refresh token, so only Skelcrew renews the login.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorText } from "../format.ts";
import { dataDir } from "../paths.ts";
import * as copies from "./login-copies.ts";

// Skelcrew's own login, which no sandbox sees, and the folder an earlier release shared with
// every agent, writable.
const ownFolder = (home: string) => join(dataDir(home), "codex-own-login");
const sharedFolder = (home: string) => join(dataDir(home), "codex-login");
// Marks Skelcrew's own login as taken from the shared folder, so it is renewed at once: agents
// from then knew its refresh token.
const takenMark = (home: string) => join(ownFolder(home), "taken-from-shared");

// What Codex keeps in auth.json: an API key, or ChatGPT's tokens and when it last renewed them.
// Whatever else it keeps goes into each copy as it is.
const Auth = z.looseObject({
  tokens: z
    .looseObject({ access_token: z.string(), refresh_token: z.string(), id_token: z.string() })
    .nullish(),
  last_refresh: z.string().nullish(),
});
type Auth = z.infer<typeof Auth>;

// What OpenAI answers a renewal with. Codex keeps a token it leaves out as it was.
const Renewed = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});

// The part of an access token Skelcrew reads: when it expires, in seconds.
const Expiry = z.object({ exp: z.number() });

// Codex's own client at OpenAI, and the address it renews at, which CODEX_REFRESH_TOKEN_URL_OVERRIDE
// changes for Codex and Skelcrew alike.
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const renewUrl = () =>
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? "https://auth.openai.com/oauth/token";

const hour = 3_600_000;
const day = 24 * hour;

// Returns whether the login an earlier release shared with every agent, writable, is still
// there, as Codex agents it started may still run on it.
export const sharedLoginLeft = (home: string) => existsSync(sharedFolder(home));

// Takes the login an earlier release shared, once no agent it started runs: copies it into a
// new file in Skelcrew's own folder, as an agent from then could have linked the old one to
// another name, removes the shared folder, and marks the login to be renewed at once.
export function takeSharedLogin(home: string, codexHome: string): void {
  const own = ownFolder(home);
  mkdirSync(own, { recursive: true, mode: 0o700 });
  const shared = join(sharedFolder(home), "auth.json");
  if (
    !existsSync(join(own, "auth.json")) &&
    lstatSync(shared, { throwIfNoEntry: false })?.isFile()
  ) {
    const aside = join(own, `.auth-${crypto.randomUUID()}.json`);
    writeFileSync(aside, readFileSync(shared), { flag: "wx", mode: 0o600 });
    renameSync(aside, join(own, "auth.json"));
    writeFileSync(takenMark(home), "");
  }
  rmSync(sharedFolder(home), { recursive: true, force: true });
  ownLogin(home, codexHome);
}

// Moves a login the first run's codex login saved in `codexHome`, Skelcrew's own CODEX_HOME,
// into Skelcrew's own login folder, and links it from there, for codex run outside the sandbox.
// Returns that folder. Throws while the login an earlier release shared is still there.
export function ownLogin(home: string, codexHome: string): string {
  if (sharedLoginLeft(home))
    throw new Error(
      "Codex agents started before Skelcrew gave each its own login still run. Restart each with sc stop and sc start, and Codex agents get their own login once none is left",
    );
  const own = ownFolder(home);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(own, { recursive: true, mode: 0o700 });
  for (const file of ["auth.json", "auth.lock"]) {
    const at = join(codexHome, file);
    const found = lstatSync(at, { throwIfNoEntry: false });
    if (found?.isSymbolicLink() && readlinkSync(at) === join(own, file)) continue;
    if (found?.isFile()) renameSync(at, join(own, file));
    else rmSync(at, { force: true });
    symlinkSync(join(own, file), at);
  }
  return own;
}

// Returns Skelcrew's own login, or null when it has none, as when Codex runs on an API key.
function readOwn(home: string): Auth | null {
  const file = join(ownFolder(home), "auth.json");
  if (!existsSync(file)) return null;
  try {
    return Auth.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`${file} isn't a Codex login, so Skelcrew can't give agents a copy of it`);
  }
}

// Returns a login as Codex writes it in auth.json.
const loginText = (auth: Auth) => `${JSON.stringify(auth, null, 2)}\n`;

// Returns an agent's copy of a login: all of it but the refresh token.
const withoutRenewal = (auth: Auth): Auth =>
  auth.tokens ? { ...auth, tokens: { ...auth.tokens, refresh_token: "" } } : auth;

// Returns a new folder for the copy of a lead's or builder's session, by its name.
export const sessionLogin = (home: string, name: string) =>
  copies.sessionLogin(home, "codex", name);

// Returns a new folder for a review's copy.
export const reviewLogin = (home: string) => copies.reviewLogin(home, "codex");

// Writes the agent's own copy of Skelcrew's login in `folder`, renewing the login first when it
// is due. Returns false and writes nothing when Skelcrew has no login, as with an API key.
export async function copyLogin(home: string, folder: string): Promise<boolean> {
  await renewLogin(home);
  const own = readOwn(home);
  if (own === null) return false;
  copies.writeCopy(folder, loginText(withoutRenewal(own)));
  return true;
}

// Returns whether Skelcrew has a login of its own to copy, rather than an API key.
export const hasLogin = (home: string) => existsSync(join(ownFolder(home), "auth.json"));

// Returns whether a session may run on the login an earlier release shared: one with no copy of
// its own while that login is still there.
export const startedShared = (home: string, name: string) =>
  sharedLoginLeft(home) && !copies.sessionsWithCopies(home, "codex").includes(name);

// Returns when an access token expires, or null when it doesn't say.
function expiry(token: string): number | null {
  try {
    const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
    return Expiry.parse(JSON.parse(payload)).exp * 1000;
  } catch {
    return null;
  }
}

// The renewal under way, which every caller waits on, so the refresh token is spent once.
let renewing: Promise<void> | null = null;
// When the last renewal failed. The next waits ten minutes, so a lost login isn't asked for
// every minute.
let failedAt = 0;

// Renews Skelcrew's login once it was last renewed a day ago, its access token expires within
// the hour, or it was just taken from the shared folder, and writes the renewal into every
// agent's copy. Codex renews its own after
// days, so an agent never needs to. A renewal that fails is logged, and the login stays as it
// was.
export function renewLogin(home: string): Promise<void> {
  renewing ??= renewNow(home).finally(() => {
    renewing = null;
  });
  return renewing;
}

async function renewNow(home: string): Promise<void> {
  const own = readOwn(home);
  const now = Date.now();
  if (!own?.tokens || now - failedAt < 10 * 60_000) return;
  const last = Date.parse(own.last_refresh ?? "");
  const expires = expiry(own.tokens.access_token);
  const taken = existsSync(takenMark(home));
  if (!taken && last > now - day && (expires === null || expires > now + hour)) return;
  let renewed: z.infer<typeof Renewed>;
  try {
    const answer = await fetch(renewUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: own.tokens.refresh_token,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await answer.text();
    if (!answer.ok) throw new Error(`OpenAI answered ${answer.status}: ${text.slice(0, 300)}`);
    renewed = Renewed.parse(JSON.parse(text));
  } catch (error) {
    failedAt = now;
    console.log(`couldn't renew Skelcrew's Codex login: ${errorText(error)}`);
    return;
  }
  const auth: Auth = {
    ...own,
    tokens: {
      ...own.tokens,
      access_token: renewed.access_token ?? own.tokens.access_token,
      refresh_token: renewed.refresh_token ?? own.tokens.refresh_token,
      id_token: renewed.id_token ?? own.tokens.id_token,
    },
    last_refresh: new Date().toISOString(),
  };
  copies.writeLogin(ownFolder(home), loginText(auth));
  rmSync(takenMark(home), { force: true });
  copies.rewriteCopies(home, "codex", loginText(withoutRenewal(auth)));
}
