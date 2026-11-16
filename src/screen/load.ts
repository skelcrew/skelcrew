// The machine's load, at the right end of the footer: how busy its cores are and how much memory
// is in use. It is the machine the screen runs on, which with sc --remote is where the agents run.
import { type CpuInfo, freemem, totalmem } from "node:os";
import { grey, paint, red, yellow } from "./look.ts";

// The idle and the total time of all cores, in milliseconds since the machine started.
export type CpuSample = { idle: number; total: number };

// Returns a sample of how long all cores have been idle, and in all, from os.cpus(). The sums are
// copied out at once, as Bun's os.cpus() reuses the objects it gave before, so an older result
// kept as it is would change to the newest times.
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

// Returns the memory in use and the total, in bytes. `meminfo` is Linux's /proc/meminfo, or
// null where there is none. On Linux, MemAvailable counts the cache the system can free as free,
// which os.freemem() would count as used. On a Mac, os.freemem() is close enough.
export function memoryInUse(meminfo: string | null): { used: number; total: number } {
  const kB = (name: string) => {
    const found = meminfo?.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
    return found ? Number(found[1]) * 1024 : null;
  };
  const total = kB("MemTotal");
  const available = kB("MemAvailable");
  if (total !== null && available !== null) return { used: total - available, total };
  return { used: totalmem() - freemem(), total: totalmem() };
}

// Returns the load as the footer shows it, such as `cpu 63%  mem 9.1/32G`. `cpu` is the busy
// share from 0 to 1, and memory is in bytes. Each figure is dim, yellow from 80% and red from
// 95%, on its own, so a busy machine catches your eye without a look at the numbers.
export function loadText(cpu: number, used: number, total: number): string {
  const G = 1024 ** 3;
  // The colour goes by the share as shown, so 80% never shows dim.
  const percent = Math.round(cpu * 100);
  const colour = (share: number) => (share >= 0.95 ? red : share >= 0.8 ? yellow : grey);
  const memory = `mem ${(used / G).toFixed(1)}/${Math.round(total / G)}G`;
  return `${paint(colour(percent / 100), `cpu ${percent}%`)}  ${paint(colour(used / total), memory)}`;
}
