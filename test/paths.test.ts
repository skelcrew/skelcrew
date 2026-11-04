import { afterEach, beforeEach, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { cliSocket } from "../src/paths";

const saved = { runtime: process.env.XDG_RUNTIME_DIR, socket: process.env.SKEL_SOCKET };
// Inside an agent's sandbox, as when skel builds skel, SKEL_SOCKET is set already.
beforeEach(() => {
  delete process.env.SKEL_SOCKET;
});
afterEach(() => {
  process.env.XDG_RUNTIME_DIR = saved.runtime;
  if (saved.socket === undefined) delete process.env.SKEL_SOCKET;
  else process.env.SKEL_SOCKET = saved.socket;
});

test("finds the daemon's socket where systemd puts it when XDG_RUNTIME_DIR isn't set", () => {
  delete process.env.XDG_RUNTIME_DIR;
  expect(cliSocket()).toBe(`/run/user/${userInfo().uid}/skel.sock`);
});

test("uses XDG_RUNTIME_DIR when it is set", () => {
  process.env.XDG_RUNTIME_DIR = "/somewhere";
  expect(cliSocket()).toBe("/somewhere/skel.sock");
});

test("inside an agent's sandbox, uses the socket mounted there", () => {
  process.env.XDG_RUNTIME_DIR = "/somewhere";
  process.env.SKEL_SOCKET = "/run/skel/skel.sock";
  expect(cliSocket()).toBe("/run/skel/skel.sock");
});
