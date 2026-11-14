import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import { normalizeWords } from "./timing";

export type Word = { text: string; start: number; end: number };

// First-line abuse protection for the single-instance Render deployment.
// Counters are intentionally in-memory: they reset on restart and are not a
// substitute for a shared store when the service scales to multiple instances.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 150;
const MAX_REQUESTS_PER_DAY = 400;
const requestHistory = new Map<string, number[]>();

function checkTranscriptionLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const history = (requestHistory.get(ip) ?? []).filter((time) => now - time < DAILY_WINDOW_MS);
  const hourly = history.filter((time) => now - time < RATE_WINDOW_MS);
  if (hourly.length >= MAX_REQUESTS_PER_HOUR) {
    requestHistory.set(ip, history);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((hourly[0]! + RATE_WINDOW_MS - now) / 1000)) };
  }
  if (history.length >= MAX_REQUESTS_PER_DAY) {
    requestHistory.set(ip, history);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((history[0]! + DAILY_WINDOW_MS - now) / 1000)) };
  }
  history.push(now);
  requestHistory.set(ip, history);

  // Keep memory bounded if many distinct IPs contact the endpoint.
  if (requestHistory.size > 5_000) {
    for (const [key, times] of requestHistory) {
      if (!times.some((time) => now - time < DAILY_WINDOW_MS)) requestHistory.delete(key);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

const groqResponseSchema = z.object({
  words: z.array(
    z.object({
      word: z.string(),
      start: z.number().finite(),
      end: z.number().finite(),
    }),
  ),
});

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        audioBase64: z.string().min(60).max(1_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
        duration: z.number().positive().max(12),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ words: Word[] } | { error: string }> => {
    const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
    const limit = checkTranscriptionLimit(ip);
    if (!limit.allowed) {
      console.warn("Transcription rate limit reached", { ip });
      return { error: "Você atingiu o limite temporário de transcrições. Aguarde um pouco e tente novamente." };
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("Transcription configuration error: GROQ_API_KEY is missing");
      return { error: "A transcrição ainda não está configurada no servidor." };
    }

    try {
      const audioBytes = Buffer.from(data.audioBase64, "base64");
      const maxAudioBytes = Math.ceil(data.duration * 16_000 * 2) + 44;
      if (audioBytes.byteLength < 44 || audioBytes.byteLength > maxAudioBytes) {
        return { error: "O trecho de áudio enviado é inválido. Tente enviar o vídeo novamente." };
      }
      const form = new FormData();
      form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "audio.wav");
      form.append("model", "whisper-large-v3");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("temperature", "0");

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        console.error("Groq transcription request failed", {
          status: response.status,
          details: details.slice(0, 1000),
        });
        if (response.status === 429) {
          return { error: "Muitas solicitações à transcrição. Aguarde um pouco e tente de novo." };
        }
        if (response.status === 401 || response.status === 403) {
          return { error: "A chave da Groq não foi aceita pelo servidor. Verifique a configuração." };
        }
        if (response.status === 413) {
          return { error: "O trecho de áudio é grande demais para a transcrição." };
        }
        return { error: "Não foi possível concluir a transcrição. Tente novamente mais tarde." };
      }

      const payload = groqResponseSchema.parse(await response.json());
      const words = normalizeWords(
        payload.words.map(({ word, start, end }) => ({
          text: word.trim(),
          start,
          end,
        })).filter((word) => word.text.length > 0),
        data.duration,
      );

      if (!words.length) return { error: "Não encontramos fala neste vídeo." };
      return { words };
    } catch (error) {
      console.error("Groq transcription processing error", error);
      return { error: "A resposta da transcrição veio incompleta. Tente novamente." };
    }
  });
