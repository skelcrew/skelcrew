// The GitHub name of the checkout you run skel in, read from its origin. It names the
// repository you attached from, on the server or, for skel --remote, on your laptop.

// Returns owner/repo from a GitHub remote URL, or null so other hosts are quietly skipped.
export function onGitHub(url: string): string | null {
  const found = url.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
  );
  return found?.[1] ?? null;
}

// Returns this checkout's GitHub name, or null when its origin cannot name a GitHub
// repository. Reading origin is the only git skel runs in your checkout: the folder only
// names the repository. It is read as written, before any insteadOf in your git config
// rewrites it.
export function originHere(): string | null {
  const origin = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return origin.success ? onGitHub(origin.stdout.toString().trim()) : null;
}
