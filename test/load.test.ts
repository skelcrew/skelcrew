// The machine's load in the footer: how busy the cores were between two samples, how the figures
// read, and when they turn yellow or red.
import { expect, test } from "bun:test";
import { type CpuInfo, totalmem } from "node:os";
import { cpuBusy, cpuSample, loadText, memoryInUse } from "../src/screen/load.ts";
import { grey, red, yellow } from "../src/screen/look.ts";

const G = 1024 ** 3;
// A core that has spent `busy` and `idle` milliseconds, its busy time all in user.
const core = (busy: number, idle: number): CpuInfo => ({
  model: "test",
  speed: 0,
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

test("the CPU figure is the busy share of all cores between two samples", () => {
  const before = [core(1000, 9000), core(500, 500)];
  // One core was busy 3 s of 5 s, the other 2 s of 5 s: 5 s busy out of 10 s.
  const after = [core(4000, 11000), core(2500, 3500)];
  expect(cpuBusy(cpuSample(before), cpuSample(after))).toBe(0.5);
});

test("with no time between the samples the CPU reads as idle", () => {
  expect(cpuBusy(cpuSample([core(1, 1)]), cpuSample([core(1, 1)]))).toBe(0);
});

test("the load reads as cpu and a percent, then memory used of total in G", () => {
  expect(Bun.stripANSI(loadText(0.634, 9.13 * G, 32 * G))).toBe("cpu 63%  mem 9.1/32G");
  expect(Bun.stripANSI(loadText(0, 0.04 * G, 15.24 * G))).toBe("cpu 0%  mem 0.0/15G");
});

test("each figure is dim below 80%, yellow from 80% and red from 95%, on its own", () => {
  expect(loadText(0.79, 1 * G, 10 * G)).toBe(
    `\x1b[${grey}mcpu 79%\x1b[22;39m  \x1b[${grey}mmem 1.0/10G\x1b[22;39m`,
  );
  expect(loadText(0.8, 9.4 * G, 10 * G)).toBe(
    `\x1b[${yellow}mcpu 80%\x1b[22;39m  \x1b[${yellow}mmem 9.4/10G\x1b[22;39m`,
  );
  expect(loadText(0.95, 9.5 * G, 10 * G)).toBe(
    `\x1b[${red}mcpu 95%\x1b[22;39m  \x1b[${red}mmem 9.5/10G\x1b[22;39m`,
  );
  expect(loadText(0.99, 1 * G, 10 * G)).toStartWith(`\x1b[${red}mcpu 99%`);
  expect(loadText(0.99, 1 * G, 10 * G)).toEndWith(`\x1b[${grey}mmem 1.0/10G\x1b[22;39m`);
});

test("memory the system can free counts as free", () => {
  const meminfo =
    "MemTotal:       16000000 kB\nMemFree:  1000000 kB\nMemAvailable:    9000000 kB\n";
  expect(memoryInUse(meminfo)).toEqual({ used: 7000000 * 1024, total: 16000000 * 1024 });
});

test("on a Mac, inactive, speculative and purgeable memory count as free", () => {
  const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            300000.
Pages inactive:                          200000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                          15000.
`;
  const total = totalmem();
  const free = (10000 + 200000 + 5000 + 15000) * 16384;
  expect(memoryInUse(vmStat)).toEqual({ used: Math.max(total - free, 0), total });
});

test("without the system's own figures, memory comes from os.freemem()", () => {
  for (const text of [null, "MemTotal:       16000000 kB\nMemFree:  1000000 kB\n"]) {
    const { used, total } = memoryInUse(text);
    expect(total).toBe(totalmem());
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(total);
  }
});

test("a total of nothing reads as dim, never as a broken colour", () => {
  expect(loadText(0, 0, 0)).toBe(
    `\x1b[${grey}mcpu 0%\x1b[22;39m  \x1b[${grey}mmem 0.0/0G\x1b[22;39m`,
  );
});
