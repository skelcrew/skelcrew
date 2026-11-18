// The machine's load, at the right end of the list's bottom line: how busy its cores are and how
// much memory is in use. It is the machine the list runs on, which with sc --remote is where the
// agents run.
import { readFileSync } from "node:fs";
import { type CpuInfo, freemem, totalmem } from "node:os";
import { z } from "zod";
import { grey, paint, red, yellow } from "./look.ts";

// The idle and the total time of all cores, in milliseconds since the machine started.
export type CpuSample = { idle: number; total: number };

// Returns a sample of how long all cores have been idle, and in all, from os.cpus(). The sums are
// copied out at once, as Bun's os.cpus() reads the times only when they are first looked at: a
// result kept and read later would hold the times from then, and the CPU figure would read 0%.
export function cpuSample(cores: CpuInfo[]): CpuSample {
  let idle = 0;
  let total = 0;
  for (const { times } of cores) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

// Returns the share of time all cores were busy between two samples, from 0 to 1. Samples, not
// the load average, so it means the same on Linux and a Mac. With no time between them it reads
// as idle rather than dividing by nothing.
export function cpuBusy(before: CpuSample, after: CpuSample): number {
  const total = after.total - before.total;
  return total > 0 ? 1 - (after.idle - before.idle) / total : 0;
}

// Returns what the system says of its memory: Linux's /proc/meminfo, or on a Mac what vm_stat
// prints, or null where neither can be read. Read every 5 seconds, so only a Mac starts a
// program for it, and a cheap one.
export function readMemory(): string | null {
  if (process.platform === "darwin") {
    const run = Bun.spawnSync(["vm_stat"], { stderr: "ignore" });
    return run.success ? run.stdout.toString() : null;
  }
  try {
    return readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null;
  }
}

// What /proc/meminfo says, in kB: a total above nothing, and no more available than that.
// Numbers too long to hold come out as Infinity, which Zod refuses.
const LinuxMemory = z
  .object({ total: z.coerce.number().int().positive(), available: z.coerce.number().int().min(0) })
  .refine((memory) => memory.available <= memory.total);
// What vm_stat says: its page size, then its free, inactive and speculative pages.
const MacMemory = z.object({
  pageSize: z.coerce.number().int().positive(),
  pages: z.array(z.coerce.number().int().min(0)),
});

// Returns the memory in use and the total, in bytes, from what readMemory gave. Memory the system
// can free counts as free: Linux's MemAvailable, which os.freemem() would count as used, and on
// a Mac the free, inactive and speculative pages, as os.freemem() there counts only the free
// ones and would show nearly all memory used. These three never overlap: vm_stat's free pages
// leave out the speculative ones. Purgeable pages are left out, as they are also active or
// inactive, and would count twice. Without either source, it uses os.freemem().
export function memoryInUse(text: string | null): { used: number; total: number } {
  // Takes the number after a name at the start of a line, such as `MemTotal:   16000000 kB`, as
  // text for Zod to check, or nothing where it isn't there.
  const figure = (name: string) => text?.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1];
  // Linux gives kB. What it says comes from outside, so a total of nothing, a number too long to
  // be one, or more available than there is, falls through to os.freemem().
  const linux = LinuxMemory.safeParse({
    total: figure("MemTotal"),
    available: figure("MemAvailable"),
  });
  if (linux.success) {
    const { total, available } = linux.data;
    return { used: (total - available) * 1024, total: total * 1024 };
  }
  // A Mac gives pages, of a size it names on its first line. Its total isn't there.
  const mac = MacMemory.safeParse({
    pageSize: text?.match(/page size of (\d+) bytes/)?.[1],
    pages: [figure("Pages free"), figure("Pages inactive"), figure("Pages speculative")],
  });
  if (mac.success) {
    const free = mac.data.pages.reduce((sum, count) => sum + count, 0) * mac.data.pageSize;
    return { used: Math.max(totalmem() - free, 0), total: totalmem() };
  }
  return { used: totalmem() - freemem(), total: totalmem() };
}

// Returns the load as the list shows it, such as `cpu 63%  mem 9.1/32G`. `cpu` is the busy
// share from 0 to 1, and memory is in bytes. Each figure is dim, yellow from 80% and red from
// 95%, on its own, so a busy machine catches your eye without a look at the numbers.
export function loadText(cpu: number, used: number, total: number): string {
  const G = 1024 ** 3;
  // The colour goes by the share as shown, so 80% never shows dim.
  const percent = Math.round(cpu * 100);
  const colour = (share: number) => (share >= 0.95 ? red : share >= 0.8 ? yellow : grey);
  const memory = `mem ${(used / G).toFixed(1)}/${Math.round(total / G)}G`;
  // A total of nothing, which no real machine has, shows dim rather than dividing by it.
  const share = total > 0 ? used / total : 0;
  return `${paint(colour(percent / 100), `cpu ${percent}%`)}  ${paint(colour(share), memory)}`;
}
