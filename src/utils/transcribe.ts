// src/utils/transcribe.ts
//
// Feature 1.8 — transcrição de áudio recebido via OpenAI Whisper.
// Baixa o áudio (URL S3 do webhook Zapster), envia ao Whisper e devolve o texto.
//
// Não é "LLM chat" (invariante 3 trata de inferência de chat) — é uma utilidade
// de STT, análoga ao embed do RAG. Lê `OPENAI_API_KEY` direto do ambiente
// (mesmo padrão de `openai-embedding.ts`).
//
// A lógica de DECISÃO (classifyInbound) e de USO (transcriptionUsable) é pura e
// testável; só `transcribeAudio` faz IO.

import { env } from '../env';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-1';
const MAX_BYTES = 25 * 1024 * 1024; // limite do Whisper: 25MB
const DOWNLOAD_TIMEOUT_MS = 20_000;
const WHISPER_TIMEOUT_MS = 60_000;

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export type InboundHandling = 'transcribe' | 'fixed_response' | 'not_media';

/**
 * Decide o tratamento da mensagem inbound (PURA):
 *   - `text` → `not_media` (segue o fluxo normal).
 *   - `audio` COM url → `transcribe`.
 *   - qualquer outra mídia, ou áudio SEM url → `fixed_response` (pede texto).
 */
export function classifyInbound(
  type: string,
  hasMediaUrl: boolean,
): InboundHandling {
  if (type === 'text') return 'not_media';
  if (type === 'audio' && hasMediaUrl) return 'transcribe';
  return 'fixed_response';
}

/** True se a transcrição é utilizável (sucesso + texto não-vazio). PURA. */
export function transcriptionUsable(r: TranscribeResult): boolean {
  return r.ok === true && typeof r.text === 'string' && r.text.trim().length > 0;
}

/** Extensão de arquivo p/ o Whisper inferir o formato, a partir do mime. PURA. */
export function extFromMime(mime: string | undefined | null): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg'; // WhatsApp PTT default = ogg/opus
}

/**
 * Baixa o áudio e transcreve via Whisper. NUNCA throw — devolve
 * `{ ok:false, error }` em qualquer falha (o caller decide o fallback).
 */
export async function transcribeAudio(
  audioUrl: string,
  mimeHint?: string,
): Promise<TranscribeResult> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY ausente' };

  // 1. Download do áudio.
  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(audioUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { ok: false, error: `download HTTP ${resp.status}` };
    contentType =
      resp.headers.get('content-type') ?? mimeHint ?? 'audio/ogg';
    bytes = await resp.arrayBuffer();
  } catch (err) {
    return {
      ok: false,
      error: `download falhou: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Guardas de tamanho.
  if (bytes.byteLength === 0) return { ok: false, error: 'áudio vazio' };
  if (bytes.byteLength > MAX_BYTES) {
    return { ok: false, error: `áudio excede 25MB (${bytes.byteLength} bytes)` };
  }

  // 3. Whisper.
  try {
    const ext = extFromMime(contentType || mimeHint);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType }), `audio.${ext}`);
    form.append('model', WHISPER_MODEL);
    form.append('language', 'pt'); // PT-BR melhora a acurácia

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WHISPER_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(OPENAI_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await resp.text();
    if (!resp.ok) {
      return { ok: false, error: `whisper HTTP ${resp.status}: ${raw.slice(0, 160)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'whisper resposta não-JSON' };
    }
    const text = (json as { text?: unknown }).text;
    if (typeof text !== 'string') return { ok: false, error: 'whisper sem campo text' };
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      error: `whisper falhou: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
