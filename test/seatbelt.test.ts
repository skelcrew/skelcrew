// The macOS sandbox profile, as plain text. Nothing here can run sandbox-exec, so these check
// the rules that draw the boundary, and that the text is well formed.
import { expect, test } from "bun:test";
import { seatbeltProfile } from "../src/agents/seatbelt.ts";

const profile = () =>
  seatbeltProfile({
    hidden: ["/Users/simon", "/private/tmp"],
    read: ["/Users/simon/.local/bin", "/Users/simon/.local/share/skelcrew/repos"],
    links: ["/Users/simon/.local/bin/claude"],
    write: ["/Users/simon/.local/share/skelcrew/lead", "/private/tmp/run/home"],
    socket: "/Users/simon/.local/share/skelcrew/run/skelcrew/lead/skelcrew.sock",
  });

// Strips strings and comments, then reports whether every bracket closes, since one bad
// bracket stops every agent from starting.
function balanced(text: string): boolean {
  const bare = text.replace(/"(\\.|[^"\\])*"/g, "").replace(/;.*$/gm, "");
  let depth = 0;
  for (const character of bare) {
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

test("is well formed, and denies whatever it doesn't name", () => {
  expect(balanced(profile())).toBe(true);
  expect(profile().startsWith('(version 1)\n(deny default (with message "skelcrew"))')).toBe(true);
});

test("hides a folder, then brings back only what the agent needs, in that order", () => {
  const text = profile();
  // The last rule that matches wins, so each must come after the one it overrides.
  const order = [
    "(allow file-read*)",
    '(deny file-read* (subpath "/Users/simon"))',
    '(allow file-read* (subpath "/Users/simon/.local/bin"))',
    '(allow file-read* (literal "/Users/simon/.local/bin/claude"))',
    '(allow file-read* file-write* (subpath "/Users/simon/.local/share/skelcrew/lead"))',
  ];
  const at = order.map((rule) => text.indexOf(rule));
  expect(at).not.toContain(-1);
  expect(at).toEqual([...at].sort((a, b) => a - b));
});

test("lets programs walk down to what came back, without listing the folders above it", () => {
  const text = profile();
  for (const folder of ["/Users/simon", "/Users/simon/.local", "/Users/simon/.local/share"])
    expect(text).toContain(`(allow file-read-metadata (literal ${JSON.stringify(folder)}))`);
  expect(text).not.toContain('(allow file-read* (literal "/Users/simon"))');
});

test("writes nowhere but the agent's folders and the terminal", () => {
  const writes = profile()
    .split("\n")
    .filter((line) => line.includes("file-write*"));
  for (const line of writes) expect(line).not.toContain('"/Users/simon/.local/bin"');
  expect(profile()).not.toContain("(allow file-write*)\n");
});

test("lets Codex check a site's certificate, but keeps your logins out of reach", () => {
  const text = profile();
  // Codex checks every connection's certificate through the Keychain's service, and with it
  // closed reaches nothing. Your login keychain is a file in your home folder, which stays
  // hidden, so the service finds none of your logins.
  expect(text).toContain('(global-name "com.apple.SecurityServer")');
  expect(text).toContain('(deny file-read* (subpath "/Users/simon"))');
  // The newer Keychain, which holds no file the sandbox could hide, stays closed.
  expect(text).not.toContain("com.apple.securityd");
});

test("never lets an agent start something outside the sandbox", () => {
  const text = profile();
  // Each of these reaches a process with your rights: open, osascript and any app.
  for (const way of ["lsopen", "appleevent-send", "com.apple.coreservices.appleevents"])
    expect(text).not.toContain(way);
  expect(text).toContain("(allow signal (target same-sandbox))");
  expect(text).not.toContain("(allow signal)");
});

test("reaches the network, but of local sockets only the agent's own and its folders", () => {
  const text = profile();
  expect(text).toContain('(allow network-outbound (remote ip "*:*"))');
  expect(text).toContain(
    '(allow network-outbound (remote unix-socket (subpath "/Users/simon/.local/share/skelcrew/run/skelcrew/lead/skelcrew.sock")))',
  );
  expect(text).toContain(
    '(allow network-bind (local unix-socket (subpath "/private/tmp/run/home")))',
  );
  // tmux's socket and the ssh agent are local sockets: open to all, they lead outside.
  expect(text).not.toContain("(allow network*)");
  expect(text).not.toContain('(path-regex #"^/")');
});

test("quotes a folder that holds a quote", () => {
  const text = seatbeltProfile({
    hidden: [],
    read: ['/Users/si"mon'],
    links: [],
    write: [],
  });
  expect(text).toContain('(subpath "/Users/si\\"mon")');
  expect(balanced(text)).toBe(true);
});
