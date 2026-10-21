import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type Word = { text: string; start: number; end: number };

const schema = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
        },
        required: ["text", "start", "end"],
        additionalProperties: false,
      },
    },
  },
  required: ["words"],
  additionalProperties: false,
};

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ audioBase64: z.string().min(100).max(20_000_000), duration: z.number().positive().max(600) })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ words: Word[] } | { error: string }> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) return { error: "Serviço de transcrição não configurado." };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "google/gemini-3.8-flash",
        stream: true,
        response_format: { type: "json_schema", json_schema: { name: "words", strict: true, schema } },
        messages: [
          {
            role: "system",
            content:
              "You are a precise forced-alignment transcription engine for short-form video captions. Transcribe every spoken word verbatim in the original language (keep accents and correct spelling, add natural punctuation attached to words). For each word return start and end time in seconds with 2-decimal precision, aligned exactly to when the word is spoken in the audio. Times must be monotonic and within the audio duration. Return JSON only.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: `Audio duration: ${data.duration.toFixed(2)} seconds. Return the word-level timestamps.` },
              { type: "input_audio", input_audio: { data: data.audioBase64, format: "wav" } },
            ],
          },
        ],
      }),
    });

    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      if (res.status === 429) return { error: "Muitas solicitações. Aguarde um pouco e tente de novo." };
      if (res.status === 402) return { error: "Créditos de IA esgotados no workspace." };
      return { error: `Falha na transcrição (${res.status}). ${t.slice(0, 200)}` };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const payload = l.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          out += j.choices?.[0]?.delta?.content ?? "";
        } catch {
          /* partial */
        }
      }
    }

    try {
      const parsed = JSON.parse(out) as { words: Word[] };
      const words = parsed.words
        .filter((w) => w.text.trim())
        .map((w) => ({
          text: w.text.trim(),
          start: Math.max(0, Math.min(w.start, data.duration)),
          end: Math.max(0, Math.min(Math.max(w.end, w.start + 0.05), data.duration)),
        }))
        .sort((a, b) => a.start - b.start);
      if (!words.length) return { error: "Não encontramos fala neste vídeo." };
      return { words };
    } catch {
      return { error: "A resposta da transcrição veio incompleta. Tente novamente." };
    }
  });
