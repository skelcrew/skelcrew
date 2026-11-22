// Each Codex agent's own copy of Skelcrew's Codex login: what a copy holds, how Skelcrew renews
// the login outside the sandbox, and how copies of ended sessions go. A local server stands in
// for OpenAI's renewals.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
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
import type { Server } from "bun";
import { z } from "zod";
import {
  copyLogin,
  ownLogin,
  renewLogin,
  reviewLogin,
  sessionLogin,
} from "../src/agents/codex-login.ts";
import { dropReviewLogins, keepLogins } from "../src/agents/harness.ts";

let home = "";
let server: Server<undefined>;
// The refresh tokens the stand-in for OpenAI was sent, in turn.
const sent: string[] = [];

const data = () => join(home, ".local", "share", "skelcrew");
const own = () => join(data(), "codex-login", "auth.json");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

// An access token that expires `inMs` from now, as OpenAI gives one.
const accessToken = (name: string, inMs: number) => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor((Date.now() + inMs) / 1000), name })}.x`;
};
const day = 86_400_000;

// Saves Skelcrew's own login as codex login does, in Skelcrew's CODEX_HOME, last renewed
// `ago` milliseconds back.
function saveLogin(ago: number, refresh = "refresh-1"): void {
  const codexHome = join(data(), "codex");
  mkdirSync(codexHome, { recursive: true });
  const auth = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id-1",
      access_token: accessToken("access-1", 10 * day),
      refresh_token: refresh,
      account_id: "acct",
    },
    last_refresh: new Date(Date.now() - ago).toISOString(),
  };
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify(auth));
  ownLogin(home, codexHome);
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const asked = z.object({ refresh_token: z.string() }).parse(await request.json());
      sent.push(asked.refresh_token);
      const n = sent.length + 1;
      return Response.json({
        access_token: accessToken(`access-${n}`, 10 * day),
        refresh_token: `refresh-${n}`,
        id_token: `id-${n}`,
      });
    },
  });
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `http://localhost:${server.port}/oauth/token`;
});
afterAll(() => {
  server.stop(true);
  delete process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
});
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-codex-login-test-")));
  sent.length = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("an agent's copy holds Skelcrew's login without its refresh token", async () => {
  saveLogin(0);
  const copy = sessionLogin(home, "app-12");
  expect(await copyLogin(home, copy)).toBe(true);
  const given = read(join(copy, "auth.json"));
  expect(given.tokens.refresh_token).toBe("");
  expect(given.tokens.access_token).toBe(read(own()).tokens.access_token);
  expect(given.tokens.account_id).toBe("acct");
  // A fresh login isn't renewed.
  expect(sent).toEqual([]);
  expect(read(own()).tokens.refresh_token).toBe("refresh-1");
});

test("with no login, as on an API key, an agent gets no copy", async () => {
  const copy = sessionLogin(home, "app-12");
  expect(await copyLogin(home, copy)).toBe(false);
  expect(existsSync(copy)).toBe(false);
});

test("what an agent writes in its copy reaches neither Skelcrew's login nor the next agent's", async () => {
  saveLogin(0);
  const first = sessionLogin(home, "app-12");
  await copyLogin(home, first);
  writeFileSync(
    join(first, "auth.json"),
    JSON.stringify({ tokens: null, OPENAI_API_KEY: "theirs" }),
  );
  const next = sessionLogin(home, "app-13");
  await copyLogin(home, next);
  expect(read(own()).tokens.refresh_token).toBe("refresh-1");
  expect(read(join(next, "auth.json")).tokens.access_token).toBe(read(own()).tokens.access_token);
});

test("Skelcrew renews a login a day old and writes the renewal into every agent's copy", async () => {
  saveLogin(0);
  const builder = sessionLogin(home, "app-12");
  const review = reviewLogin(home);
  await copyLogin(home, builder);
  await copyLogin(home, review);
  saveLogin(2 * day);
  await renewLogin(home);
  // Renewed once, with Skelcrew's own refresh token, which only Skelcrew's login keeps.
  expect(sent).toEqual(["refresh-1"]);
  expect(read(own()).tokens.refresh_token).toBe("refresh-2");
  expect(read(own()).tokens.account_id).toBe("acct");
  for (const copy of [builder, review]) {
    const given = read(join(copy, "auth.json"));
    expect(given.tokens.access_token).toBe(read(own()).tokens.access_token);
    expect(given.tokens.refresh_token).toBe("");
    expect(given.last_refresh).toBe(read(own()).last_refresh);
  }
  // Two agents starting at once renew it once.
  saveLogin(2 * day, "refresh-2");
  await Promise.all([
    copyLogin(home, sessionLogin(home, "a")),
    copyLogin(home, sessionLogin(home, "b")),
  ]);
  expect(sent).toEqual(["refresh-1", "refresh-2"]);
});

test("the copies of sessions that ended go, and those of sessions that run stay", async () => {
  saveLogin(0);
  // Copies an earlier daemon wrote.
  for (const name of ["app-12", "app-13"]) {
    mkdirSync(sessionLogin(home, name), { recursive: true });
    writeFileSync(join(sessionLogin(home, name), "auth.json"), "{}");
  }
  // One this daemon just wrote, whose session may still be starting.
  await copyLogin(home, sessionLogin(home, "app-14"));
  const review = reviewLogin(home);
  await copyLogin(home, review);
  await keepLogins(home, async (name) => name === "app-13");
  expect(existsSync(sessionLogin(home, "app-12"))).toBe(false);
  expect(existsSync(sessionLogin(home, "app-13"))).toBe(true);
  expect(existsSync(sessionLogin(home, "app-14"))).toBe(true);
  // A review's copy goes only as the daemon starts, when no review runs.
  expect(existsSync(review)).toBe(true);
  dropReviewLogins(home);
  expect(existsSync(review)).toBe(false);
});
