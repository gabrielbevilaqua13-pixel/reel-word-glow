import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Loader2, RotateCcw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { transcribeAudio, type Word } from "@/lib/transcribe.functions";
import { STYLES, drawCaptions, groupWords, loadCaptionFonts, retextChunk, toSrt } from "@/lib/captions";
import { extractWavSegments, renderVideo } from "@/lib/media";
import { mergeSegments } from "@/lib/timing";
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
  const [textColor, setTextColor] = useState("#ffffff");
  const [highlightColor, setHighlightColor] = useState("#e4ff3a");
  const [boxColor, setBoxColor] = useState("#ff4d2e");
  const [showHighlightBox, setShowHighlightBox] = useState(false);
  const [maxWords, setMaxWords] = useState(3);
  const [posY, setPosY] = useState(0.68);
  const [scale, setScale] = useState(1);
  const [exporting, setExporting] = useState<number | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const baseStyle = STYLES.find((s) => s.id === styleId) ?? STYLES[0]!;
  const style = useMemo(() => ({ ...baseStyle, fill: textColor, active: highlightColor, accent: baseStyle.accent ? highlightColor : baseStyle.accent, box: showHighlightBox ? boxColor : undefined, boxText: textColor }), [baseStyle, textColor, highlightColor, boxColor, showHighlightBox]);
  useEffect(() => {
    setTextColor(baseStyle.fill);
    setHighlightColor(baseStyle.accent ?? baseStyle.active);
    setBoxColor(baseStyle.box ?? "#ff4d2e");
    setShowHighlightBox(Boolean(baseStyle.box));
  }, [styleId]);
  const chunks = useMemo(() => groupWords(words, maxWords), [words, maxWords]);

  const handleFile = async (f: File) => {
    if (!f.type.startsWith("video/")) return setError("Envie um arquivo de vídeo."), setPhase("error");
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setPhase("transcribing");
    setError("");
    try {
      const { segments, duration } = await extractWavSegments(f);
      if (duration > 600) throw new Error("Vídeos de até 10 minutos.");
      const all: Word[][] = new Array(segments.length);
      let next = 0;
      const worker = async () => {
        while (next < segments.length) {
          const k = next++;
           const seg = segments[k];
           if (!seg) continue;
          const res = await transcribe({ data: { audioBase64: seg.base64, duration: seg.duration } });
          if ("error" in res) {
            if (res.error.startsWith("Não encontramos fala")) { all[k] = []; continue; }
            throw new Error(res.error);
          }
           all[k] = res.words;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, segments.length) }, worker));
       const merged = mergeSegments(all, segments, duration);
      if (!merged.length) throw new Error("Não encontramos fala neste vídeo.");
      setWords(merged);
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
    setUrl("");
    setError("");
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
    <main className="mx-auto min-h-screen max-w-[1440px] px-4 pb-16 pt-5 sm:px-6 lg:px-10">
      <header className="mb-14 flex items-center justify-between border-b border-white/10 pb-5">
        <a href="/" className="group flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-lg font-black text-primary-foreground shadow-glow">L.</div>
          <div>
            <div className="font-display text-lg font-extrabold tracking-tight">legenda<span className="text-primary">.</span></div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Creator studio</div>
          </div>
        </a>
        <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-4 py-2 text-xs text-muted-foreground sm:flex">
          <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" />
          Seu estúdio de legendas
        </div>
        {phase === "ready" && (
          <Button variant="outline" className="rounded-full border-white/15 bg-white/[0.04]" onClick={reset}>
            <RotateCcw /> Novo projeto
          </Button>
        )}
      </header>

      <section className="mb-10 max-w-3xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.2em] text-primary">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Legendas que prendem atenção
        </div>
        <h1 className="font-display text-4xl font-extrabold leading-[1.04] tracking-[-0.055em] sm:text-6xl lg:text-7xl">
          Dê voz às suas ideias.<br /><span className="text-primary">Destaque cada palavra.</span>
        </h1>
        <p className="mt-5 max-w-xl text-sm leading-7 text-muted-foreground sm:text-base">
          Transforme seus vídeos em conteúdo pronto para publicar. Transcrição automática, legendas sincronizadas e estilos que valorizam sua mensagem.
        </p>
      </section>

      <div className="mb-8 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3">
        {[
          { n: "01", label: "Envie seu vídeo", active: phase === "idle" || phase === "error" },
          { n: "02", label: "Personalize", active: phase === "ready" },
          { n: "03", label: "Exporte", active: exporting !== null },
        ].map((step) => (
          <div key={step.n} className={cn("flex items-center gap-2 rounded-xl border px-3 py-3 transition", step.active ? "border-primary/35 bg-primary/[0.07]" : "border-white/[0.07] bg-white/[0.02]")}>
            <span className={cn("font-mono text-xs font-bold", step.active ? "text-primary" : "text-muted-foreground/60")}>{step.n}</span>
            <span className={cn("text-[10px] font-bold sm:text-xs", step.active ? "text-foreground" : "text-muted-foreground/60")}>{step.label}</span>
          </div>
        ))}
      </div>

      {(phase === "idle" || phase === "error") && (
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.025] p-3 shadow-2xl sm:p-5">
          <Dropzone onFile={handleFile} error={phase === "error" ? error : ""} />
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-2 pb-3 pt-5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-primary" /> MP4 e MOV</span>
            <span>Até 10 minutos</span>
            <span>Transcrição automática</span>
            <span>Exportação em vídeo</span>
          </div>
        </div>
      )}

      {phase === "transcribing" && (
        <div className="grid min-h-[420px] place-items-center rounded-[2rem] border border-white/10 bg-white/[0.025] px-6 py-16 text-center">
          <div className="max-w-md">
            <div className="mx-auto mb-7 grid h-20 w-20 place-items-center rounded-3xl border border-primary/25 bg-primary/10 text-primary shadow-glow">
              <Loader2 className="h-9 w-9 animate-spin" />
            </div>
            <div className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Estamos ouvindo<span className="text-primary">.</span></div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">Detectando a fala e sincronizando cada palavra do seu vídeo. Você poderá revisar tudo antes de exportar.</p>
            <div className="mx-auto mt-8 h-1.5 max-w-xs overflow-hidden rounded-full bg-white/10"><div className="h-full w-1/2 animate-pulse rounded-full bg-primary" /></div>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.35fr)]">
          <div className="space-y-4 xl:sticky xl:top-6">
            <div className="flex items-center justify-between px-1">
              <div>
                <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">Pré-visualização</div>
                <div className="mt-1 text-sm font-semibold">Veja as legendas em ação</div>
              </div>
              <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[10px] font-bold text-primary">AO VIVO</span>
            </div>
            <div className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-3 sm:p-4">
              <Preview url={url} chunks={chunks} style={style} posY={posY} scale={scale} onTime={setNow} />
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-muted-foreground">PROJETO ATUAL</span>
                <span className="text-primary">Pronto para editar</span>
              </div>
              <p className="mt-2 truncate text-sm font-semibold">{file?.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{chunks.length} blocos de legenda · {words.length} palavras detectadas</p>
            </div>
          </div>

          <section className="space-y-5">
            <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.025] p-5 sm:p-6">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">01 / Aparência</div>
                  <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight">Escolha seu estilo</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Uma identidade visual para cada tipo de conteúdo.</p>
                </div>
                <span className="rounded-lg bg-primary/10 px-2.5 py-1.5 text-[10px] font-bold text-primary">5 PRESETS</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {STYLES.map((s) => (
                  <button key={s.id} onClick={() => setStyleId(s.id)} className={cn("group rounded-xl border px-3 py-4 text-center transition-all", s.id === styleId ? "border-primary/70 bg-primary/[0.09] shadow-glow" : "border-white/[0.08] bg-black/10 hover:border-white/25 hover:bg-white/[0.04]")}>
                    <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-black/30 text-2xl" style={{ color: s.active, fontFamily: s.font, fontWeight: s.weight, fontStyle: s.italic ? "italic" : "normal", textTransform: s.upper ? "uppercase" : "none", textShadow: "0 2px 10px #000" }}>Aa</div>
                    <div className="mt-3 text-xs font-bold">{s.name}</div>
                    <div className={cn("mt-1 text-[9px]", s.id === styleId ? "text-primary" : "text-muted-foreground")}>{s.id === styleId ? "Selecionado" : "Aplicar estilo"}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.025] p-5 sm:p-6">
              <div className="mb-6">
                <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">02 / Ajustes</div>
                <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight">Refine sua legenda</h2>
              </div>
              <div className="grid gap-7 sm:grid-cols-3">
                <Control label="Palavras por vez" value={String(maxWords)}>
                  <Slider min={1} max={6} step={1} value={[maxWords]} onValueChange={(v) => setMaxWords(v[0] ?? 3)} />
                </Control>
                <Control label="Altura na tela" value={`${Math.round(posY * 100)}%`}>
                  <Slider min={0.15} max={0.88} step={0.01} value={[posY]} onValueChange={(v) => setPosY(v[0] ?? 0.68)} />
                </Control>
                <Control label="Escala do texto" value={`${Math.round(scale * 100)}%`}>
                  <Slider min={0.6} max={1.6} step={0.05} value={[scale]} onValueChange={(v) => setScale(v[0] ?? 1)} />
                </Control>
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.025] p-5 sm:p-6">
              <div className="mb-5">
                <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">03 / Identidade visual</div>
                <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight">Suas cores, sua marca</h2>
                <p className="mt-1 text-xs text-muted-foreground">Personalize o texto e a palavra em destaque. As mudanças aparecem na prévia e na exportação.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <ColorControl label="Texto" value={textColor} onChange={setTextColor} />
                <ColorControl label="Destaque" value={highlightColor} onChange={setHighlightColor} />
                <ColorControl label="Fundo do destaque" value={boxColor} onChange={setBoxColor} />
              </div>
              <label className="mt-5 flex cursor-pointer items-center gap-3 text-sm text-muted-foreground">
                <input type="checkbox" checked={showHighlightBox} onChange={(e) => setShowHighlightBox(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
                Aplicar fundo colorido à palavra ativa
              </label>
              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-4">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Combinações rápidas</span>
                {[
                  { name: "Clássico", text: "#ffffff", highlight: "#e4ff3a", box: "#ff4d2e", enabled: false },
                  { name: "Editorial", text: "#f4ead8", highlight: "#d5ad72", box: "#34271f", enabled: false },
                  { name: "Monocromático", text: "#ffffff", highlight: "#bdbdbd", box: "#ffffff", enabled: true },
                  { name: "Noite", text: "#f8fafc", highlight: "#7dd3fc", box: "#075985", enabled: true },
                ].map((preset) => (
                  <button key={preset.name} onClick={() => { setTextColor(preset.text); setHighlightColor(preset.highlight); setBoxColor(preset.box); setShowHighlightBox(preset.enabled); }} className="rounded-full border border-white/10 px-3 py-1.5 text-[10px] font-bold text-muted-foreground transition hover:border-primary/50 hover:text-foreground">{preset.name}</button>
                ))}
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.025] p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">04 / Revisão</div>
                  <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight">Texto transcrito</h2>
                </div>
                <span className="rounded-full bg-white/[0.06] px-3 py-1 text-[10px] font-bold text-muted-foreground">{chunks.length} LEGENDAS</span>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">Clique em qualquer linha para corrigir o texto. As marcações de tempo serão preservadas.</p>
              <div className="max-h-[360px] space-y-1.5 overflow-y-auto pr-1">
                {chunks.map((c, i) => (
                  <div key={c.id + c.words.map((w) => w.text).join()} className={cn("flex items-center gap-3 rounded-xl border px-3 py-3 transition", now >= c.start && now < c.end ? "border-primary/35 bg-primary/[0.07]" : "border-white/[0.045] bg-black/10 hover:border-white/10")}>
                    <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{c.start.toFixed(1)}s</span>
                    <input defaultValue={c.words.map((w) => w.text).join(" ")} onBlur={(e) => e.target.value !== c.words.map((w) => w.text).join(" ") && editChunk(i, e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground focus:text-primary" />
                    <span className="text-[10px] text-muted-foreground/50">↵</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-primary/25 bg-primary/[0.055] p-5 sm:p-6">
              <div className="mb-4">
                <div className="text-xs font-extrabold uppercase tracking-[0.18em] text-primary">05 / Finalização</div>
                <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight">Seu vídeo está quase pronto.</h2>
                <p className="mt-1 text-xs text-muted-foreground">Exporte o vídeo com as legendas aplicadas ou baixe o arquivo SRT.</p>
              </div>
              {exporting !== null ? (
                <div className="space-y-3">
                  <Progress value={exporting * 100} className="h-2 bg-primary/15" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Renderizando vídeo… mantenha esta aba aberta.</span><strong className="text-primary">{Math.round(exporting * 100)}%</strong></div>
                </div>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button size="lg" onClick={exportVideo} className="h-12 flex-1 rounded-xl font-extrabold shadow-glow">
                    <Download /> Exportar vídeo
                  </Button>
                  <Button size="lg" variant="outline" onClick={() => download(new Blob([toSrt(chunks)], { type: "text/plain" }), "legendas.srt")} className="h-12 rounded-xl border-white/15 bg-white/[0.04]">
                    <FileText /> Baixar SRT
                  </Button>
                </div>
              )}
              {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            </div>
          </section>
        </div>
      )}

      <footer className="mt-16 flex flex-col items-center justify-between gap-3 border-t border-white/[0.08] pt-6 text-center text-[10px] text-muted-foreground sm:flex-row sm:text-left">
        <span className="font-display text-sm font-extrabold tracking-tight text-foreground">legenda<span className="text-primary">.</span></span>
        <span>Feito para criadores que têm algo a dizer.</span>
        <span>LEGENDA STUDIO · 2026</span>
      </footer>
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

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-black/10 p-3">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="h-10 w-12 cursor-pointer rounded-lg border-0 bg-transparent p-0" />
      <span className="min-w-0">
        <span className="block text-xs font-bold text-foreground">{label}</span>
        <span className="mt-1 block font-mono text-[10px] uppercase text-muted-foreground">{value}</span>
      </span>
    </label>
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
        "group relative flex min-h-[340px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[1.6rem] border border-dashed px-6 py-14 text-center transition-all sm:min-h-[390px]",
        over ? "border-primary bg-primary/[0.09] shadow-glow" : "border-white/15 bg-black/10 hover:border-primary/50 hover:bg-primary/[0.035]",
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" style={{ backgroundImage: "radial-gradient(circle at 50% 45%, color-mix(in oklab, var(--primary) 10%, transparent), transparent 48%)" }} />
      <div className={cn("relative mb-6 grid h-20 w-20 place-items-center rounded-[1.6rem] border transition-all duration-300", over ? "scale-105 border-primary bg-primary text-primary-foreground shadow-glow" : "border-primary/25 bg-primary/10 text-primary group-hover:-translate-y-1 group-hover:border-primary/50 group-hover:shadow-glow")}>
        <Upload className="h-8 w-8" />
      </div>
      <div className="relative font-display text-2xl font-extrabold tracking-tight sm:text-3xl">{over ? "Solte para começar" : "Arraste seu vídeo para cá"}</div>
      <p className="relative mt-3 max-w-sm text-sm leading-6 text-muted-foreground">ou clique para selecionar um arquivo no seu dispositivo. A transcrição e a sincronização acontecem automaticamente.</p>
      <span className="relative mt-7 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-xs font-extrabold text-primary-foreground shadow-glow transition-transform group-hover:scale-[1.03]">Selecionar vídeo <Upload className="h-3.5 w-3.5" /></span>
      <div className="relative mt-7 flex flex-wrap justify-center gap-2">
        {["MP4", "MOV", "Até 10 minutos"].map((item) => <span key={item} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[10px] font-bold tracking-wide text-muted-foreground">{item}</span>)}
      </div>
      {error && <p className="relative mt-5 rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p>}
      <input type="file" accept="video/mp4,video/quicktime,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
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
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let raf = 0;
    let videoFrame = 0;
    let lastFallbackDraw = 0;
    let lastActiveChunk = -2;
    let disposed = false;

    const drawFrame = (time: number) => {
      if (disposed || !video.videoWidth) return;
      // Keep the preview canvas lightweight even when the source is 4K.
      const maxDimension = 720;
      const ratio = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * ratio));
      const height = Math.max(1, Math.round(video.videoHeight * ratio));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const s = state.current;
      drawCaptions(ctx, width, height, s.chunks, time, s.style, { posY: s.posY, scale: s.scale });

      // Update the editor only when the active caption changes, not every 100 ms.
      // This prevents the entire transcript/editor UI from re-rendering during playback.
      const activeChunk = s.chunks.findIndex((chunk) => time >= chunk.start && time < chunk.end);
      if (activeChunk !== lastActiveChunk) {
        lastActiveChunk = activeChunk;
        onTime(time);
      }
    };

    const handleVideoFrame = (_: number, metadata: VideoFrameCallbackMetadata) => {
      if (disposed) return;
      drawFrame(metadata.mediaTime);
      videoFrame = video.requestVideoFrameCallback(handleVideoFrame);
    };

    const fallbackTick = (now: number) => {
      if (disposed) return;
      if (now - lastFallbackDraw >= 33) {
        lastFallbackDraw = now;
        drawFrame(video.currentTime);
      }
      raf = requestAnimationFrame(fallbackTick);
    };

    void loadCaptionFonts().then(() => {
      if (disposed) return;
      drawFrame(video.currentTime);
    });

    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrame = video.requestVideoFrameCallback(handleVideoFrame);
      video.addEventListener("timeupdate", () => drawFrame(video.currentTime));
      video.addEventListener("seeked", () => drawFrame(video.currentTime));
      video.addEventListener("pause", () => drawFrame(video.currentTime));
    } else {
      raf = requestAnimationFrame(fallbackTick);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (videoFrame && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(videoFrame);
      }
    };
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
