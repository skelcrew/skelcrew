#!/bin/sh
# Installs skel: finds this machine's system and CPU, downloads the right binary from the latest
# release, checks its checksum and puts it in ~/.local/bin. Run as curl ... | sh, with no sudo.
set -eu

# The one place that says where releases live. The latest release's binaries and SHA256SUMS
# file are under $base/latest/download, and those of v0.4.2 under $base/download/v0.4.2, which
# is how GitHub lays them out. The release build reads this line, so that skel can fetch its own
# release for a server. To move releases, change this line and RELEASES_REPO in
# .github/workflows/release.yml, and keep that layout.
base="${SKELCREW_DOWNLOAD_BASE:-https://github.com/skelcrew/skelcrew/releases}"

# Says why skel can't be installed and stops, leaving things as they were.
fail() {
  echo "skel: $*" >&2
  exit 1
}

# Prints the system as release files name it, or stops on one skel isn't built for.
find_system() {
  system=$(uname -s)
  case "$system" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      fail "skel doesn't run on Windows yet. It runs on macOS and Linux."
      ;;
    *) fail "skel runs on macOS and Linux, and this machine runs $system." ;;
  esac
}

# Prints the CPU as release files name it, or stops on one skel isn't built for. A terminal
# running through Rosetta says x86_64 on an Apple Silicon Mac, where the arm64 binary is the
# one that runs natively, so the Mac is asked directly.
find_cpu() {
  cpu=$(uname -m)
  case "$cpu" in
    arm64 | aarch64) echo arm64 ;;
    x86_64 | amd64)
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        echo arm64
      else
        echo x64
      fi
      ;;
    *) fail "skel runs on arm64 and x64 CPUs, and this machine has $cpu." ;;
  esac
}

# Stops on Linux without glibc, such as Alpine: the binaries are built for glibc, and would
# only fail later with a message about a missing file.
require_glibc() {
  if ldd --version 2>&1 | grep -qi musl; then
    fail "skel needs a Linux with glibc, and this one uses musl."
  fi
}

# Prints the SHA-256 of the file `skel` in this folder. Linux has sha256sum and a Mac shasum.
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sum=$(sha256sum skel)
  elif command -v shasum >/dev/null 2>&1; then
    sum=$(shasum -a 256 skel)
  else
    fail "installing skel needs sha256sum or shasum, to check the download."
  fi
  echo "${sum%% *}"
}

# Stops unless the file `skel` in this folder is the one the release lists under `asset`, so a
# broken or altered download never gets installed.
verify() {
  asset=$1
  want=$(awk -v name="$asset" '$2 == name { print $1 }' SHA256SUMS)
  [ -n "$want" ] || fail "the release has no checksum for $asset, so it wasn't installed."
  got=$(checksum)
  [ "$got" = "$want" ] || fail "the download failed its checksum, so it wasn't installed. Try again."
}

# Downloads an address to a file, or stops and names the address.
download() {
  curl -fL --progress-bar -o "$2" "$1" || fail "couldn't download $1"
}

# Says skel is in place and what to do next, first how to reach it if the PATH doesn't.
finish() {
  echo "Installed $1 in ~/.local/bin."
  case ":$PATH:" in
    *":$2:"*) echo "Run skel to get started." ;;
    *)
      echo "~/.local/bin isn't on your PATH. Add this line to your shell's startup file,"
      echo "such as ~/.zshrc or ~/.bashrc:"
      echo
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      echo
      echo "Then open a new terminal and run skel to get started."
      ;;
  esac
}

# Installs skel. Everything happens in a folder beside the final file, so the last step is a
# rename: an old skel keeps working until the new one is complete, and a running skel or a
# link to a checkout's skel is replaced, not written through. macOS also kills a program whose
# file was overwritten in place, which a rename can't cause.
main() {
  command -v curl >/dev/null 2>&1 || fail "installing skel needs curl, which isn't installed."
  [ -n "${HOME:-}" ] || fail "HOME isn't set, so there is nowhere to install skel."
  system=$(find_system)
  cpu=$(find_cpu)
  [ "$system" != linux ] || require_glibc
  asset="skel-$system-$cpu"
  bin="$HOME/.local/bin"
  mkdir -p "$bin" || fail "couldn't make $bin."
  folder=$(mktemp -d "$bin/.skel-install.XXXXXX") || fail "couldn't write to $bin."
  trap 'rm -rf "$folder"' EXIT
  trap 'exit 1' HUP INT TERM
  cd "$folder"
  echo "Downloading skel for $system on $cpu."
  # The small file first: both must come from one release, and a new one could otherwise land
  # during the long download. If one still slips between them, the checksum stops the install.
  download "$base/latest/download/SHA256SUMS" SHA256SUMS
  download "$base/latest/download/$asset" skel
  verify "$asset"
  chmod 755 skel
  version=$(./skel --version) || fail "the download won't start on this machine, so it wasn't installed."
  mv -f skel "$bin/skel"
  finish "$version" "$bin"
}

# Called on the last line, so a download that breaks off partway runs nothing.
main
