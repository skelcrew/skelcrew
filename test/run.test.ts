// Running a short program and reading what it printed, as the commands that reach GitHub,
// servers and Sprites do.
import { afterEach, expect, test } from "bun:test";
import { quietly } from "../src/run.ts";

const sh = (line: string) => ["sh", "-c", line];

afterEach(() => {
  delete process.env.SKELCREW_RUN_TEST;
});

test("gives back what a program printed, apart and together", async () => {
  const ran = await quietly(sh("echo out; echo err >&2"));
  expect(ran).toEqual({ out: "out\n", err: "err\n", said: "out\nerr", ok: true });
});

test("reports a program that failed, with what it said", async () => {
  const ran = await quietly(sh("echo why >&2; exit 3"));
  expect(ran.ok).toBe(false);
  expect(ran.err).toBe("why\n");
});

test("gives a program no input unless handed some", async () => {
  expect((await quietly(sh("cat"))).out).toBe("");
  expect((await quietly(sh("cat"), { stdin: new Blob(["typed"]) })).out).toBe("typed");
});

test("hands on the environment it is given", async () => {
  const ran = await quietly(sh('echo "$SKELCREW_RUN_TEST"'), {
    env: { SKELCREW_RUN_TEST: "given" },
  });
  expect(ran.out).toBe("given\n");
});

// Some commands depend on this: they run with the environment skel started with, and a
// default of process.env would change what they see.
test("hands on no change to process.env unless given the environment", async () => {
  process.env.SKELCREW_RUN_TEST = "changed";
  expect((await quietly(sh('echo "$SKELCREW_RUN_TEST"'))).out).toBe("\n");
  expect((await quietly(sh('echo "$SKELCREW_RUN_TEST"'), { env: process.env })).out).toBe(
    "changed\n",
  );
});

test("drops an output it is told to ignore", async () => {
  const line = "echo out; echo err >&2";
  expect(await quietly(sh(line), { stdout: "ignore" })).toMatchObject({ out: "", err: "err\n" });
  expect(await quietly(sh(line), { stderr: "ignore" })).toMatchObject({ out: "out\n", err: "" });
});
