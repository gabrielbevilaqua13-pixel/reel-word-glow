import type { Word } from "./transcribe.functions";

export type Chunk = { id: string; words: Word[]; start: number; end: number };

export function groupWords(words: Word[], maxWords: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    chunks.push({ id: `${cur[0]!.start}-${chunks.length}`, words: cur, start: cur[0]!.start, end: cur[cur.length - 1]!.end });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (cur.length && prev && w.start - prev.end > 0.6) flush();
    cur.push(w);
    if (cur.length >= maxWords || /[.!?…]$/.test(w.text)) flush();
  });
  flush();
  // hold each chunk on screen until the next begins (max 0.5s extra)
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    const c = chunks[i]!;
    c.end = next ? Math.min(next.start, c.end + 0.5) : c.end + 0.5;
  }
  return chunks;
}

/** Replace a chunk's text keeping timing: same word count maps 1:1, otherwise redistributes evenly. */
export function retextChunk(chunk: Chunk, text: string): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  if (tokens.length === chunk.words.length) return chunk.words.map((w, i) => ({ ...w, text: tokens[i]! }));
  const s = chunk.words[0]!.start;
  const e = chunk.words[chunk.words.length - 1]!.end;
  const step = (e - s) / tokens.length;
  return tokens.map((t, i) => ({ text: t, start: s + i * step, end: s + (i + 1) * step }));
}

export type CaptionStyle = {
  id: string;
  name: string;
  font: string;
  weight: number;
  italic?: boolean;
  upper: boolean;
  fill: string;
  active: string;
  stroke?: string;
  box?: string;
  boxText?: string;
  dimInactive?: boolean;
  shadow?: boolean;
  sizeFactor: number;
};

export const STYLES: CaptionStyle[] = [
  { id: "impacto", name: "Impacto", font: "Montserrat", weight: 900, upper: true, fill: "#ffffff", active: "#e4ff3a", stroke: "#000000", sizeFactor: 1 },
  { id: "caixa", name: "Caixa", font: "Montserrat", weight: 800, upper: false, fill: "#ffffff", active: "#ffffff", box: "#ff4d2e", stroke: "#000000", sizeFactor: 0.92 },
  { id: "elegante", name: "Elegante", font: "DM Serif Display", weight: 400, italic: true, upper: false, fill: "#ffffff", active: "#ffffff", dimInactive: true, shadow: true, sizeFactor: 1.05 },
  { id: "cinema", name: "Cinema", font: "Anton", weight: 400, upper: true, fill: "#ffd60a", active: "#ffd60a", stroke: "#000000", sizeFactor: 1.1 },
];

export async function loadCaptionFonts() {
  await Promise.all(STYLES.map((s) => document.fonts.load(`${s.italic ? "italic " : ""}${s.weight} 40px "${s.font}"`)));
}

export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  chunks: Chunk[],
  t: number,
  style: CaptionStyle,
  opts: { posY: number; scale: number },
) {
  const chunk = chunks.find((c) => t >= c.start && t < c.end);
  if (!chunk) return;
  const size = Math.round(Math.min(w, h * 0.5625) * 0.085 * opts.scale * style.sizeFactor);
  ctx.font = `${style.italic ? "italic " : ""}${style.weight} ${size}px "${style.font}"`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const space = ctx.measureText(" ").width * 1.25;
  const maxW = w * 0.84;
  const tokens = chunk.words.map((wd) => ({ wd, s: style.upper ? wd.text.toUpperCase() : wd.text }));
  const lines: { items: typeof tokens; width: number }[] = [];
  let line: typeof tokens = [];
  let lw = 0;
  for (const tk of tokens) {
    const tw = ctx.measureText(tk.s).width;
    if (line.length && lw + space + tw > maxW) {
      lines.push({ items: line, width: lw });
      line = [];
      lw = 0;
    }
    lw += (line.length ? space : 0) + tw;
    line.push(tk);
  }
  if (line.length) lines.push({ items: line, width: lw });

  const age = t - chunk.start;
  const pop = Math.min(1, age / 0.12);
  const ease = 1 - Math.pow(1 - pop, 3);
  const lineH = size * 1.18;
  const cy = h * opts.posY;
  ctx.save();
  ctx.translate(w / 2, cy);
  ctx.scale(0.88 + 0.12 * ease, 0.88 + 0.12 * ease);
  ctx.globalAlpha = ease;
  const top = -((lines.length - 1) * lineH) / 2;
  lines.forEach((ln, li) => {
    let x = -ln.width / 2;
    const y = top + li * lineH;
    for (const tk of ln.items) {
      const tw = ctx.measureText(tk.s).width;
      const isActive = t >= tk.wd.start && t < tk.wd.end + 0.02;
      const spoken = t >= tk.wd.start;
      ctx.save();
      if (style.box && isActive) {
        const px = size * 0.18;
        ctx.fillStyle = style.box;
        roundRect(ctx, x - px, y - size * 0.6, tw + px * 2, size * 1.2, size * 0.2);
        ctx.fill();
      }
      let fill = isActive ? style.active : style.fill;
      if (style.dimInactive && !spoken) ctx.globalAlpha *= 0.45;
      if (style.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = size * 0.35;
        ctx.shadowOffsetY = size * 0.06;
      }
      const scaleW = isActive && !style.box && style.active !== style.fill ? 1.04 : 1;
      ctx.translate(x + tw / 2, y);
      ctx.scale(scaleW, scaleW);
      if (style.stroke && !(style.box && isActive)) {
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = size * 0.16;
        ctx.strokeText(tk.s, -tw / 2, 0);
      }
      if (style.box && isActive) fill = style.boxText ?? "#ffffff";
      ctx.fillStyle = fill;
      ctx.fillText(tk.s, -tw / 2, 0);
      ctx.restore();
      x += tw + space;
    }
  });
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function toSrt(chunks: Chunk[]) {
  const f = (s: number) => {
    const ms = Math.round(s * 1000);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, "0")}`;
  };
  return chunks.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.words.map((w) => w.text).join(" ")}\n`).join("\n");
}
