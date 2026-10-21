import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Loader2, RotateCcw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { transcribeAudio, type Word } from "@/lib/transcribe.functions";
import { STYLES, drawCaptions, groupWords, loadCaptionFonts, retextChunk, toSrt } from "@/lib/captions";
import { extractWavBase64, renderVideo } from "@/lib/media";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Legenda — legendas precisas e bonitas para Reels" },
      { name: "description", content: "Envie seu Reel, receba legendas palavra por palavra, escolha o estilo e baixe o vídeo pronto." },
      { property: "og:title", content: "Legenda — legendas precisas e bonitas para Reels" },
      { property: "og:description", content: "Legendas animadas palavra por palavra para Reels do Instagram." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Phase = "idle" | "transcribing" | "ready" | "error";

function Index() {
  const transcribe = useServerFn(transcribeAudio);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [words, setWords] = useState<Word[]>([]);
  const [styleId, setStyleId] = useState("impacto");
  const [maxWords, setMaxWords] = useState(3);
  const [posY, setPosY] = useState(0.68);
  const [scale, setScale] = useState(1);
  const [exporting, setExporting] = useState<number | null>(null);
  const [now, setNow] = useState(0);

  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0]!;
  const chunks = useMemo(() => groupWords(words, maxWords), [words, maxWords]);

  const handleFile = async (f: File) => {
    if (!f.type.startsWith("video/")) return setError("Envie um arquivo de vídeo."), setPhase("error");
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setPhase("transcribing");
    setError("");
    try {
      const { base64, duration } = await extractWavBase64(f);
      if (duration > 600) throw new Error("Vídeos de até 10 minutos.");
      const res = await transcribe({ data: { audioBase64: base64, duration } });
      if ("error" in res) throw new Error(res.error);
      setWords(res.words);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Algo deu errado.");
      setPhase("error");
    }
  };

  const reset = () => {
    setPhase("idle");
    setWords([]);
    setFile(null);
  };

  const exportVideo = async () => {
    setExporting(0);
    try {
      await loadCaptionFonts();
      const { blob, ext } = await renderVideo(file!, url, chunks, style, { posY, scale }, setExporting);
      download(blob, `${(file?.name ?? "reel").replace(/\.[^.]+$/, "")}-legendado.${ext}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao exportar.");
    } finally {
      setExporting(null);
    }
  };

  const editChunk = (idx: number, text: string) => {
    const c = chunks[idx];
    if (!c?.words[0]) return;
    const first = words.indexOf(c.words[0]);
    const next = [...words];
    next.splice(first, c.words.length, ...retextChunk(c, text));
    setWords(next);
  };

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 md:py-12">
      <header className="mb-10 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight md:text-6xl">
            legenda<span className="text-primary">.</span>
          </h1>
          <p className="mt-2 max-w-md text-muted-foreground">Legendas palavra por palavra, sincronizadas e lindas, para os seus Reels.</p>
        </div>
        {phase === "ready" && (
          <Button variant="ghost" onClick={reset}>
            <RotateCcw /> Novo vídeo
          </Button>
        )}
      </header>

      {(phase === "idle" || phase === "error") && (
        <Dropzone onFile={handleFile} error={phase === "error" ? error : ""} />
      )}

      {phase === "transcribing" && (
        <div className="grid place-items-center gap-6 py-20 text-center">
          <div className="font-display text-5xl font-extrabold text-primary animate-caption-pulse md:text-7xl">OUVINDO…</div>
          <p className="text-muted-foreground">Transcrevendo e sincronizando cada palavra. Leva alguns segundos.</p>
        </div>
      )}

      {phase === "ready" && (
        <div className="grid gap-10 md:grid-cols-[minmax(0,380px)_1fr]">
          <Preview url={url} chunks={chunks} style={style} posY={posY} scale={scale} onTime={setNow} />

          <section className="space-y-8">
            <div>
              <Label>Estilo</Label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {STYLES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setStyleId(s.id)}
                    className={cn(
                      "rounded-xl border bg-card px-3 py-4 text-center transition",
                      s.id === styleId ? "border-primary shadow-glow" : "hover:border-muted-foreground",
                    )}
                  >
                    <div
                      className="text-xl leading-none"
                      style={{ fontFamily: s.font, fontWeight: s.weight, fontStyle: s.italic ? "italic" : "normal", textTransform: s.upper ? "uppercase" : "none" }}
                    >
                      Aa
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{s.name}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-3">
              <Control label="Palavras por vez" value={String(maxWords)}>
                <Slider min={1} max={6} step={1} value={[maxWords]} onValueChange={(v) => setMaxWords(v[0] ?? 3)} />
              </Control>
              <Control label="Posição" value={`${Math.round(posY * 100)}%`}>
                <Slider min={0.15} max={0.88} step={0.01} value={[posY]} onValueChange={(v) => setPosY(v[0] ?? 0.68)} />
              </Control>
              <Control label="Tamanho" value={`${Math.round(scale * 100)}%`}>
                <Slider min={0.6} max={1.6} step={0.05} value={[scale]} onValueChange={(v) => setScale(v[0] ?? 1)} />
              </Control>
            </div>

            <div>
              <Label>Texto ({chunks.length} legendas) — clique para corrigir</Label>
              <div className="max-h-80 space-y-1.5 overflow-y-auto pr-2">
                {chunks.map((c, i) => (
                  <div
                    key={c.id + c.words.map((w) => w.text).join()}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border border-transparent px-3 py-2",
                      now >= c.start && now < c.end ? "border-primary/50 bg-secondary" : "bg-card",
                    )}
                  >
                    <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{c.start.toFixed(1)}s</span>
                    <input
                      defaultValue={c.words.map((w) => w.text).join(" ")}
                      onBlur={(e) => e.target.value !== c.words.map((w) => w.text).join(" ") && editChunk(i, e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      className="w-full bg-transparent text-sm outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              {exporting !== null ? (
                <div className="space-y-2">
                  <Progress value={exporting * 100} />
                  <p className="text-sm text-muted-foreground">Gravando o vídeo com legendas… {Math.round(exporting * 100)}% (mantenha esta aba aberta)</p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <Button size="lg" onClick={exportVideo} className="font-bold">
                    <Download /> Baixar vídeo legendado
                  </Button>
                  <Button size="lg" variant="secondary" onClick={() => download(new Blob([toSrt(chunks)], { type: "text/plain" }), "legendas.srt")}>
                    <FileText /> Baixar .SRT
                  </Button>
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">{children}</div>;
}

function Control({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
        <span>{label}</span>
        <span className="text-foreground">{value}</span>
      </div>
      {children}
    </div>
  );
}

function Dropzone({ onFile, error }: { onFile: (f: File) => void; error: string }) {
  const [over, setOver] = useState(false);
  return (
    <label
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed px-6 py-24 text-center transition",
        over ? "border-primary bg-secondary" : "border-border hover:border-muted-foreground",
      )}
    >
      <div className="grid h-16 w-16 place-items-center rounded-full bg-primary text-primary-foreground">
        <Upload />
      </div>
      <div className="font-display text-2xl font-extrabold">Solte seu Reel aqui</div>
      <p className="text-sm text-muted-foreground">MP4 ou MOV, vertical 9:16. A fala é detectada automaticamente.</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <input type="file" accept="video/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </label>
  );
}

function Preview({
  url,
  chunks,
  style,
  posY,
  scale,
  onTime,
}: {
  url: string;
  chunks: ReturnType<typeof groupWords>;
  style: (typeof STYLES)[number];
  posY: number;
  scale: number;
  onTime: (t: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ chunks, style, posY, scale });
  state.current = { chunks, style, posY, scale };

  useEffect(() => {
    let raf = 0;
    let last = -1;
    loadCaptionFonts();
    const tick = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.videoWidth) {
        if (c.width !== v.videoWidth) {
          c.width = v.videoWidth;
          c.height = v.videoHeight;
        }
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, c.width, c.height);
        const s = state.current;
        drawCaptions(ctx, c.width, c.height, s.chunks, v.currentTime, s.style, { posY: s.posY, scale: s.scale });
        if (Math.abs(v.currentTime - last) > 0.1) {
          last = v.currentTime;
          onTime(v.currentTime);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [onTime]);

  return (
    <div className="mx-auto w-full max-w-[380px]">
      <div className="relative aspect-[9/16] overflow-hidden rounded-[2rem] bg-card shadow-phone">
        <video ref={videoRef} src={url} controls playsInline loop className="absolute inset-0 h-full w-full object-contain" />
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground">Dê play para ver as legendas em tempo real.</p>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
