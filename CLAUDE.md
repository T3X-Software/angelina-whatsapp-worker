# whatsapp-worker — Harness Lua

Agente WhatsApp para o Espaço Angelinos. A harness orquestra tudo ao redor do Claude —
validação, fila, memória, hooks, tools e observabilidade.

## Arquitetura de referência
Ler `../Harness-Architecture.md` e `../Monorepo-Structure.md` antes de qualquer mudança.

## Fases de execução (ordem imutável)
```
BEFORE_REQUEST → after_model → BEFORE_SEND
```
Dentro de `BEFORE_REQUEST` (ordem):
  rate-limit-guard → admin-router → load-context → build-conversation-summary → after-hours-guard

Dentro de `AFTER_MODEL` (ordem):
  transfer-trigger → format-whatsapp → media-sender

Dentro de `BEFORE_SEND` (ordem):
  human-delay → response-guard   ← response-guard SEMPRE é o último

## Invariantes
Ver invariantes da harness em `../CLAUDE.md` — fonte única do projeto. Não duplicar aqui.

## Acesso ao banco — Drizzle read-only do schema
- **Schema é gerado via `npm run db:pull`** (alias para `drizzle-kit pull`).
- O arquivo `src/db/schema.ts` é **gerado, não editado à mão**. Nunca commitar mudança manual.
- **NUNCA usar `drizzle-kit push`, `generate` ou qualquer comando que escreva no banco.**
  Toda alteração de schema é feita pelo Supabase do app web.
- Cliente Drizzle exportado em `src/db/client.ts` como `db`. Importar via `import { db } from '../db/client'`.
- Queries: usar a sintaxe declarativa do Drizzle (`db.select().from(messages).where(eq(...))`).

## Short-circuit
Qualquer hook pode retornar `{ shortCircuit: true }` para abortar o turno imediatamente.
Hooks que fazem short-circuit: rate-limit-guard, admin-router, after-hours-guard,
response-guard, idempotency (duplicata).

## EventBus
Todos os eventos do turno são emitidos para o EventBus (`harness/event-bus.ts`).
Ao fim do turno, o tracer faz flush em batch para a tabela `traces`.
Não persistir eventos manualmente — sempre usar `eventBus.emit(eventType, payload)`.

## Fallback LLM
O `llm/router.ts` tenta Claude 2× antes de acionar OpenAI GPT-4o.
Se ambos falham: envia `agent_configs.fallback_message` e aborta o turno.
Nunca chamar `anthropic.ts` ou `openai.ts` diretamente — sempre via `llm/router.ts`.

## Configuração hot-reload
Nunca hardcodar prompts, modelos, links ou números de WhatsApp.
Tudo vive em `agent_configs` (cache 30s). Usar `config/agent-configs.ts`.

## Estrutura de pastas em `src/`
- `db/` — `schema.ts` (gerado), `client.ts` (singleton Drizzle), `relations.ts` (gerado)
- `harness/` — loop principal, event-bus, tracer
- `hooks/` — ver `src/hooks/CLAUDE.md`
- `tools/` — ver `src/tools/CLAUDE.md`
- `llm/` — `router.ts`, `anthropic.ts`, `openai.ts`
- `queue/` — BullMQ producer/consumer
- `config/` — leitura de `agent_configs` com cache
- `zapster/` — cliente Zapster API

## Deploy (VPS — PM2)
Produção roda sob **PM2** como `angelina-worker`, executando `node dist/main.js`.
`dist/` é **gitignored** → `git pull` NÃO atualiza o compilado; o build TEM que rodar no VPS.

```bash
git pull origin main
npm ci
npm run build && echo "BUILD OK"          # CRÍTICO — regenera dist/ (gitignored)
pm2 reload angelina-worker --update-env   # ✅ reload = graceful, sem downtime
```

- **Use `pm2 reload`, NÃO `pm2 restart`.** `restart` mata e sobe o processo (≈1–2min de
  janela em que o edge Fastify fica fora → webhooks da Zapster que chegam nesse intervalo
  se perdem). `reload` é graceful (validado 2026-06-25).
- Se pular o `npm run build`, o PM2 segue servindo o `dist/` antigo (sintoma: features novas
  não aparecem / warning de "unknown tool names"). Confirme: `grep -c <símboloNovo> dist/...js`.
- Health check: `GET /healthz` → `{ ok: true }` (`edge/server.ts`). É **liveness rasa** — não
  verifica DB/Redis/BullMQ. Aprofundar para readiness é melhoria em aberto.

## Adicionar novo bloco
Ver `../Monorepo-Structure.md` seção do bloco correspondente para localização e convenções.
