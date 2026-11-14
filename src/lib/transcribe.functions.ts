import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizeWords } from "./timing";

export type Word = { text: string; start: number; end: number };

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
        audioBase64: z.string().min(100).max(20_000_000),
        duration: z.number().positive().max(600),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ words: Word[] } | { error: string }> => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("Transcription configuration error: GROQ_API_KEY is missing");
      return { error: "A transcrição ainda não está configurada no servidor." };
    }

    try {
      const audioBytes = Buffer.from(data.audioBase64, "base64");
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
