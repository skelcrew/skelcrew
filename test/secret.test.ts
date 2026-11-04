// Turning what you type or paste at the token question into the token, and what is shown
// for it while you type.
import { expect, test } from "bun:test";
import { masked, typeKeys } from "../src/secret.ts";

test("keeps each character, and ends on Enter", () => {
  expect(typeKeys("", "abc\r")).toEqual({ token: "abc", end: "enter", pending: "" });
  expect(typeKeys("ab", "c\n")).toEqual({ token: "abc", end: "enter", pending: "" });
});

test("keeps reading until Enter", () => {
  expect(typeKeys("", "sk-ant")).toEqual({ token: "sk-ant", end: null, pending: "" });
});

test("backspace takes back the last character", () => {
  expect(typeKeys("", "ab\x7fc\r")).toEqual({ token: "ac", end: "enter", pending: "" });
  expect(typeKeys("a", "\b")).toEqual({ token: "", end: null, pending: "" });
});

test("backspace with nothing typed changes nothing", () => {
  expect(typeKeys("", "\x7f")).toEqual({ token: "", end: null, pending: "" });
});

test("leaves the paste markers out of a pasted token", () => {
  const pasted = typeKeys("", "\x1b[200~sk-ant-oat01-good\x1b[201~");
  expect(pasted).toEqual({ token: "sk-ant-oat01-good", end: null, pending: "" });
});

test("keeps a paste marker split across two reads out of the token", () => {
  const first = typeKeys("", "\x1b[20");
  expect(first).toEqual({ token: "", end: null, pending: "\x1b[20" });
  const second = typeKeys(first.token, `${first.pending}0~sk-ant-oat01-good\x1b`);
  expect(second.token).toBe("sk-ant-oat01-good");
  expect(second.pending).toBe("\x1b");
  const last = typeKeys(second.token, `${second.pending}[201~\r`);
  expect(last).toEqual({ token: "sk-ant-oat01-good", end: "enter", pending: "" });
});

test("leaves out arrow keys and other control keys", () => {
  expect(typeKeys("", "a\x1b[Db\x1bOA\tc\r")).toEqual({ token: "abc", end: "enter", pending: "" });
});

test("Enter right after Escape still ends the question", () => {
  expect(typeKeys("ab", "\x1b\r").end).toBe("enter");
});

test("Ctrl-C stops, whatever was typed", () => {
  expect(typeKeys("", "ab\x03c\r").end).toBe("stop");
});

// A star per character would wrap a 108-character token on an 80-column terminal, and
// backspace can't step back across the wrap.
test("shows a short row of stars and the count, never longer than one line", () => {
  expect(masked(0)).toBe("");
  expect(masked(1)).toBe("* 1 character");
  expect(masked(5)).toBe("***** 5 characters");
  expect(masked(108)).toBe("******************** 108 characters");
});
