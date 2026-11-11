// The remote of the checkout you run sc in, read from its origin. It names the repository
// you attached from, on the server or, for sc --remote, on your laptop.

// Returns the host a remote URL is on and the owner and name its path ends with, such as
// github.com and simon/app for git@github.com:simon/app.git, or null for one with no owner in
// it. A repository with no forge is named by this.
export function pathOf(url: string): { host: string; owner: string; repo: string } | null {
  // A URL with a scheme, such as https://github.com/simon/app or ssh://git@host:22/simon/app,
  // or else the short form scp uses, such as git@github.com:simon/app.git.
  const found =
    url.match(/^[\w+.-]+:\/\/(?:[^@/]*@)?([^/:]*)(?::\d+)?\/(.*)$/) ??
    url.match(/^(?:[^@/:]*@)?([^/:]+):(.*)$/);
  const parts =
    found?.[2]
      ?.replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split("/") ?? [];
  // A path deeper than two parts, as some forges allow, is named by its last two.
  const [owner, repo] = parts.slice(-2);
  // A part such as .. or one with a space can't name an owner or repository.
  const part = /^(?!\.\.?$)[\w.-]+$/;
  if (!owner || !repo || !part.test(owner) || !part.test(repo)) return null;
  return { host: (found?.[1] ?? "").toLowerCase(), owner, repo };
}

// Returns the remote URL of the checkout in the folder, this one unless told, or null when it has
// no origin. Reading origin is the only git Skelcrew runs in your checkout, besides finding its top
// for sc init: the folder only names the repository. It is read as written, before any insteadOf
// in your git config rewrites it.
export function originHere(folder = "."): string | null {
  const origin = Bun.spawnSync(["git", "-C", folder, "config", "--get", "remote.origin.url"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = origin.stdout.toString().trim();
  return origin.success && url ? url : null;
}
