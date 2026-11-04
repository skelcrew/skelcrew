import { afterEach, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { cliSocket } from "../src/paths";

const saved = process.env.XDG_RUNTIME_DIR;
afterEach(() => {
  process.env.XDG_RUNTIME_DIR = saved;
});

test("finds the daemon's socket where systemd puts it when XDG_RUNTIME_DIR isn't set", () => {
  delete process.env.XDG_RUNTIME_DIR;
  expect(cliSocket()).toBe(`/run/user/${userInfo().uid}/skel.sock`);
});

test("uses XDG_RUNTIME_DIR when it is set", () => {
  process.env.XDG_RUNTIME_DIR = "/somewhere";
  expect(cliSocket()).toBe("/somewhere/skel.sock");
});
