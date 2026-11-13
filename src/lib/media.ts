import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
} from "mediabunny";
import { drawCaptions, type CaptionStyle, type Chunk } from "./captions";
import { segmentWindows, type SegmentWindow } from "./timing";

const RATE = 16000;

export type AudioSegment = SegmentWindow & { base64: string };

/**
 * Decode on the media timeline (including track offsets and gaps), then use
 * short windows with context on both sides of each ownership boundary.
 */
export async function extractWavSegments(file: File, target = 8): Promise<{ segments: AudioSegment[]; duration: number }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    if (duration > 600) throw new Error("Vídeos de até 10 minutos.");
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Não foi possível ler a duração do vídeo.");
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("Não encontramos áudio neste vídeo.");
    const off = new OfflineAudioContext(1, Math.ceil(duration * RATE), RATE);
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      if (timestamp + buffer.duration <= 0 || timestamp >= duration) continue;
      const src = off.createBufferSource();
      src.buffer = buffer;
      src.connect(off.destination);
      src.start(Math.max(0, timestamp), Math.max(0, -timestamp));
    }
    const pcm = (await off.startRendering()).getChannelData(0);
    const segments = segmentWindows(pcm, RATE, target).map((window) => ({
      ...window,
      base64: encodeWav(pcm.subarray(Math.round(window.offset * RATE), Math.round((window.offset + window.duration) * RATE))),
    }));
    return { segments, duration };
  } finally {
    input.dispose();
  }
}

function encodeWav(pcm: Float32Array): string {
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ws = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  ws(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  ws(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Renders the captioned video frame by frame (not in real time), so no frames
 * are dropped and the output never stutters. Falls back to real-time capture
 * only when the browser lacks WebCodecs support.
 */
export async function renderVideo(
  file: File,
  url: string,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  if (typeof VideoEncoder !== "undefined") {
    try {
      return await renderPrecise(file, chunks, style, opts, onProgress);
    } catch (e) {
      console.warn("Renderização precisa falhou, usando captura em tempo real:", e);
    }
  }
  return renderRealtime(url, chunks, style, opts, onProgress);
}

async function renderPrecise(
  file: File,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      quality: QUALITY_VERY_HIGH,
      allowTransformationMetadata: false,
      process: (sample) => {
        const w = sample.displayWidth;
        const h = sample.displayHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        sample.draw(ctx, 0, 0, w, h);
        drawCaptions(ctx, w, h, chunks, sample.timestamp, style, opts);
        return canvas;
      },
    },
    showWarnings: false,
  });

  if (!conversion.isValid) throw new Error("Não foi possível converter este vídeo.");

  conversion.onProgress = (p) => onProgress(p);
  await conversion.execute();

  const buffer = target.buffer;
  if (!buffer) throw new Error("Falha ao finalizar o vídeo.");
  onProgress(1);
  return { blob: new Blob([buffer], { type: "video/mp4" }), ext: "mp4" };
}

async function renderRealtime(
  url: string,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const video = document.createElement("video");
  video.src = url;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  await new Promise<void>((r, j) => {
    video.onloadedmetadata = () => r();
    video.onerror = () => j(new Error("Não foi possível ler o vídeo."));
  });
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  ac.createMediaElementSource(video).connect(dest);
  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));

  let raf = 0;
  const loop = () => {
    ctx.drawImage(video, 0, 0, w, h);
    drawCaptions(ctx, w, h, chunks, video.currentTime, style, opts);
    onProgress(video.currentTime / video.duration);
    raf = requestAnimationFrame(loop);
  };
  video.currentTime = 0;
  rec.start(250);
  await video.play();
  loop();
  await new Promise<void>((r) => (video.onended = () => r()));
  cancelAnimationFrame(raf);
  rec.stop();
  await done;
  await ac.close();
  onProgress(1);
  return { blob: new Blob(parts, { type: mime.split(";")[0] ?? mime }), ext: mime.startsWith("video/mp4") ? "mp4" : "webm" };
}
