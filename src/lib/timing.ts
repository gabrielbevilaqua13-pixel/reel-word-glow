export type TimedWord = { text: string; start: number; end: number };
export type SegmentWindow = { offset: number; duration: number; keepStart: number; keepEnd: number };

/** Keep real pauses; never stretch an entire transcript to fit its duration. */
export function normalizeWords(words: TimedWord[], duration: number): TimedWord[] {
  const sorted = words.filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end)
    && w.end > w.start && w.start < duration && w.end > 0)
    .map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: Math.min(duration, w.end) }))
    .sort((a, b) => a.start - b.start);
  const result: TimedWord[] = [];
  for (const word of sorted) {
    const prev = result.at(-1);
    if (prev && prev.text === word.text && Math.abs(prev.start - word.start) < 0.08) continue;
    if (prev && word.start < prev.end) prev.end = word.start;
    if (prev && prev.end <= prev.start) result.pop();
    result.push(word);
  }
  return result;
}

/** Each boundary belongs to exactly one segment; context words are not repeated. */
export function mergeSegments(results: TimedWord[][], windows: SegmentWindow[], duration: number): TimedWord[] {
  return normalizeWords(results.flatMap((words, i) => {
    const window = windows[i];
    if (!window) return [];
    return words.map((w) => ({ ...w, start: w.start + window.offset, end: w.end + window.offset }))
      .filter((w) => (w.start + w.end) / 2 >= window.keepStart && (w.start + w.end) / 2 < window.keepEnd);
  }), duration);
}

/** Favor sustained quiet rather than a single zero crossing inside a syllable. */
export function segmentWindows(pcm: Float32Array, rate: number, target = 8): SegmentWindow[] {
  const duration = pcm.length / rate;
  const cuts = [0];
  const windowSize = Math.round(rate * 0.12);
  let last = 0;
  while (pcm.length - last > (target + 2) * rate) {
    const base = last + target * rate;
    let best = base, energy = Infinity;
    for (let p = base - rate; p <= base + rate; p += Math.round(rate * 0.02)) {
      let sum = 0;
      for (let i = p; i < p + windowSize && i < pcm.length; i++) sum += (pcm[i] ?? 0) ** 2;
      if (sum < energy) { energy = sum; best = p + Math.floor(windowSize / 2); }
    }
    last = Math.round(best);
    cuts.push(last);
  }
  cuts.push(pcm.length);
  return cuts.slice(0, -1).map((cut, i) => {
    const end = cuts[i + 1] ?? pcm.length;
    const offset = Math.max(0, cut / rate - 0.65);
    return { offset, duration: Math.min(duration, end / rate + 0.65) - offset, keepStart: cut / rate, keepEnd: end / rate };
  });
}