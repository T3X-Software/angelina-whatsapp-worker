// src/utils/notification-targets.ts
//
// Feature C (item 3.1) — resolução da lista de alvos da notificação de handoff.
// Função PURA (sem IO): lê `hook_params.notification_targets` (E.164), normaliza
// (trim) e deduplica; faz fallback para `support_whatsapp` quando a lista está
// vazia/ausente (preserva o comportamento legado de número único).
//
// Isolada do hook de propósito: o `transfer-trigger` importa `db`/harness, o que
// dificultaria testar esta lógica sem inicializar conexão. Aqui fica testável
// por um smoke simples (scripts/smoke-notification-targets.ts).

export type NotificationTargetsSource =
  | 'notification_targets'
  | 'support_whatsapp_fallback'
  | 'none';

export interface ResolvedNotificationTargets {
  /** Números E.164 (limpos, deduplicados) que recebem a notificação. */
  targets: string[];
  /** De onde vieram os alvos — para tracing/observabilidade. */
  source: NotificationTargetsSource;
}

/**
 * Resolve os alvos da notificação de handoff.
 *
 * Precedência:
 *   1. `notification_targets` não-vazio (após trim/dedup) → usa a lista.
 *   2. senão, `support_whatsapp` não-vazio → lista de 1 (fallback legado).
 *   3. senão → lista vazia (nenhuma notificação).
 *
 * Defensivo: aceita `unknown` em `notificationTargets` (a config vem de JSONB,
 * pode vir malformada) — qualquer item não-string é descartado.
 */
export function resolveNotificationTargets(
  notificationTargets: unknown,
  supportWhatsapp: string | null | undefined,
): ResolvedNotificationTargets {
  const raw = Array.isArray(notificationTargets) ? notificationTargets : [];
  const cleaned = Array.from(
    new Set(
      raw
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0),
    ),
  );
  if (cleaned.length > 0) {
    return { targets: cleaned, source: 'notification_targets' };
  }

  const fallback = (supportWhatsapp ?? '').trim();
  if (fallback.length > 0) {
    return { targets: [fallback], source: 'support_whatsapp_fallback' };
  }

  return { targets: [], source: 'none' };
}
