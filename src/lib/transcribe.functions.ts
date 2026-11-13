import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizeWords } from "./timing";

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
    const { streamChatCompletion, GatewayError } = await import("@lovable.dev/ai-gateway");
    try {
      const stream = await streamChatCompletion({
        model: "google/gemini-3.8-flash",
        response_format: { type: "json_schema", json_schema: { name: "words", strict: true, schema } },
        messages: [
          {
            role: "system",
            content:
              "Transcribe the actual audible speech verbatim in its original language, one word per item. Listen to the entire clip, then verify each word's onset and offset against the audio. Return seconds relative to the very beginning of this clip (including any leading silence), with 3-decimal precision. Preserve pauses: never distribute words evenly, estimate timestamps from reading speed, or stretch timings to fill the clip. Include audible words near both edges; overlapping context will be merged separately. No invented speech, music lyrics unless clearly audible, or timestamps beyond the clip. Each end must exceed start; words must be chronological and non-overlapping. Return an empty words array for no speech. Return JSON only.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: `Clip duration: ${data.duration.toFixed(3)} seconds. Time zero is the first audio sample, not the first spoken word. Return exact word-level timestamps after checking the beginning, middle and end against what you hear.` },
              { type: "input_audio", input_audio: { data: data.audioBase64, format: "wav" } },
            ],
          },
        ],
      });
      let out = "";
      for await (const event of stream) {
        const choice = event.choices?.[0];
        if (choice?.finish_reason && choice.finish_reason !== "stop") {
          return { error: "A resposta da transcrição veio incompleta. Tente novamente." };
        }
        out += choice?.delta?.content ?? "";
      }
      const parsed = z.object({ words: z.array(z.object({
        text: z.string(), start: z.number().finite(), end: z.number().finite(),
      })) }).parse(JSON.parse(out));
      const words = normalizeWords(parsed.words, data.duration);
      if (!words.length) return { error: "Não encontramos fala neste vídeo." };
      return { words };
    } catch (error) {
      if (error instanceof GatewayError) {
        console.error("Transcription gateway failure", error.code, error.ids);
        if (error.httpStatus === 429) return { error: "Muitas solicitações. Aguarde um pouco e tente de novo." };
        if (error.httpStatus === 402) return { error: "Créditos de IA esgotados no workspace." };
        return { error: "Não foi possível concluir a transcrição. Tente novamente mais tarde." };
      }
      return { error: "A resposta da transcrição veio incompleta. Tente novamente." };
    }
  });
