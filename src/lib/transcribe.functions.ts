import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import { z } from "zod";
import { normalizeWords } from "./timing";

export type Word = { text: string; start: number; end: number };

const RATE_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 150;
const MAX_REQUESTS_PER_DAY = 400;
const requestHistory = new Map<string, number[]>();
let warnedAboutRedis = false;

type RedisValue = string | number | null | RedisValue[];

function parseResp(buffer: Buffer, offset = 0): { value: RedisValue; next: number } | null {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]!);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const header = buffer.toString("utf8", offset + 1, lineEnd);

  if (type === "+" || type === "-") {
    if (type === "-") throw new Error(`Valkey error: ${header}`);
    return { value: header, next: lineEnd + 2 };
  }
  if (type === ":") return { value: Number(header), next: lineEnd + 2 };
  if (type === "$") {
    const length = Number(header);
    if (length === -1) return { value: null, next: lineEnd + 2 };
    const end = lineEnd + 2 + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString("utf8", lineEnd + 2, end), next: end + 2 };
  }
  if (type === "*") {
    const count = Number(header);
    if (count === -1) return { value: null, next: lineEnd + 2 };
    const values: RedisValue[] = [];
    let cursor = lineEnd + 2;
    for (let i = 0; i < count; i += 1) {
      const item = parseResp(buffer, cursor);
      if (!item) return null;
      values.push(item.value);
      cursor = item.next;
    }
    return { value: values, next: cursor };
  }
  throw new Error("Unsupported Valkey response");
}

function encodeResp(args: string[]): string {
  return `*${args.length}\r\n` + args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("");
}

async function runRedisCommand(redisUrl: string, command: string[]): Promise<RedisValue> {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  const port = Number(url.port || 6379);
  const commands: string[][] = [];
  if (url.password) {
    commands.push(url.username
      ? ["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)]
      : ["AUTH", decodeURIComponent(url.password)]);
  }
  const database = url.pathname.replace(/^\//, "");
  if (database && database !== "0") commands.push(["SELECT", database]);
  commands.push(command);

  return new Promise((resolve, reject) => {
    const socket = url.protocol === "rediss:"
      ? connectTls({ host: url.hostname, port, servername: url.hostname })
      : createConnection({ host: url.hostname, port });
    let buffer = Buffer.alloc(0);
    let parsedCount = 0;
    let lastValue: RedisValue = null;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(4000, () => fail(new Error("Valkey connection timed out")));
    socket.once(url.protocol === "rediss:" ? "secureConnect" : "connect", () => {
      socket.write(commands.map(encodeResp).join(""));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (parsedCount < commands.length) {
          const parsed = parseResp(buffer);
          if (!parsed) break;
          lastValue = parsed.value;
          buffer = buffer.subarray(parsed.next);
          parsedCount += 1;
        }
        if (parsedCount === commands.length && !settled) {
          settled = true;
          socket.end();
          resolve(lastValue);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Valkey response error"));
      }
    });
    socket.on("error", (error) => fail(error));
  });
}

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local member = ARGV[2]
local hour = tonumber(ARGV[3])
local day = tonumber(ARGV[4])
local maxHour = tonumber(ARGV[5])
local maxDay = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - day)
local hourly = redis.call('ZCOUNT', key, now - hour, '+inf')
if hourly >= maxHour then
  local oldest = redis.call('ZRANGEBYSCORE', key, now - hour, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  return {0, math.max(1, math.ceil((tonumber(oldest[2]) + hour - now) / 1000))}
end
local daily = redis.call('ZCARD', key)
if daily >= maxDay then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, math.max(1, math.ceil((tonumber(oldest[2]) + day - now) / 1000))}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(day / 1000))
return {1, 0}
`;

function checkLocalTranscriptionLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
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
  if (requestHistory.size > 5_000) {
    for (const [key, times] of requestHistory) {
      if (!times.some((time) => now - time < DAILY_WINDOW_MS)) requestHistory.delete(key);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

async function checkTranscriptionLimit(ip: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const ipHash = createHash("sha256").update(ip).digest("hex");
      const result = await runRedisCommand(redisUrl, [
        "EVAL",
        RATE_LIMIT_SCRIPT,
        "1",
        `transcription-limit:${ipHash}`,
        String(Date.now()),
        `${Date.now()}:${randomUUID()}`,
        String(RATE_WINDOW_MS),
        String(DAILY_WINDOW_MS),
        String(MAX_REQUESTS_PER_HOUR),
        String(MAX_REQUESTS_PER_DAY),
      ]);
      if (!Array.isArray(result) || typeof result[0] !== "number" || typeof result[1] !== "number") {
        throw new Error("Unexpected Valkey rate-limit response");
      }
      return { allowed: result[0] === 1, retryAfterSeconds: result[1] };
    } catch (error) {
      if (!warnedAboutRedis) {
        console.warn("Shared rate-limit store unavailable; using in-memory fallback", error);
        warnedAboutRedis = true;
      }
    }
  }
  return checkLocalTranscriptionLimit(ip);
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
    const limit = await checkTranscriptionLimit(ip);
    if (!limit.allowed) {
      console.warn("Transcription rate limit reached");
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
