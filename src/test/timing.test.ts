import { describe, expect, it } from "vitest";
import { mergeSegments, normalizeWords, segmentWindows } from "@/lib/timing";
import { groupWords } from "@/lib/captions";

describe("caption timing", () => {
  it("preserves leading silence, late timestamps and long speech pauses", () => {
    expect(normalizeWords([
      { text: "início", start: 2.15, end: 2.5 },
      { text: "fim", start: 58.3, end: 58.7 },
    ], 60)).toEqual([
      { text: "início", start: 2.15, end: 2.5 },
      { text: "fim", start: 58.3, end: 58.7 },
    ]);
  });
  it("prevents simultaneous highlights and rejects invalid or out-of-range words", () => {
    expect(normalizeWords([
      { text: "um", start: 1, end: 2 }, { text: "dois", start: 1.8, end: 2.4 },
      { text: "inválido", start: NaN, end: 3 }, { text: "fora", start: 9, end: 10 },
      { text: "zero", start: 3, end: 3 },
    ], 5)).toEqual([{ text: "um", start: 1, end: 1.8 }, { text: "dois", start: 1.8, end: 2.4 }]);
  });
  it("merges overlapping context once without removing intentional repeated speech", () => {
    const result = mergeSegments([
      [{ text: "não", start: 7.5, end: 7.8 }, { text: "não", start: 7.9, end: 8.2 }],
      [{ text: "não", start: 0.15, end: 0.45 }, { text: "não", start: 0.55, end: 0.85 }],
    ], [
      { offset: 0, duration: 8.65, keepStart: 0, keepEnd: 8 },
      { offset: 7.35, duration: 8.65, keepStart: 8, keepEnd: 16 },
    ], 16);
    expect(result).toHaveLength(2);
    expect(result[1]?.start).toBeCloseTo(7.9);
  });
  it("creates complete ownership coverage with context on both sides", () => {
    const pcm = new Float32Array(30000).fill(0.3);
    pcm.fill(0, 7950, 8200);
    const windows = segmentWindows(pcm, 1000);
    expect(windows[0]?.keepStart).toBe(0);
    expect(windows.at(-1)?.keepEnd).toBe(30);
    expect(windows[0]?.keepEnd).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1], current = windows[i];
      expect(current?.keepStart).toBe(prev?.keepEnd);
      expect(current?.offset).toBeLessThan(current?.keepStart ?? 0);
      expect((prev?.offset ?? 0) + (prev?.duration ?? 0)).toBeGreaterThan(current?.keepStart ?? 0);
    }
  });
  it("does not let the previous caption hide the next one or persist across silence", () => {
    const chunks = groupWords([
      { text: "primeiro", start: 1, end: 1.4 }, { text: "segundo", start: 1.45, end: 1.8 },
      { text: "depois", start: 4, end: 4.3 },
    ], 1);
    expect(chunks[0]?.end).toBe(1.45);
    expect(chunks[1]?.end).toBe(2.3);
    expect(chunks.find((c) => 1.45 >= c.start && 1.45 < c.end)?.words[0]?.text).toBe("segundo");
  });
});