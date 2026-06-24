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

## Adicionar novo bloco
Ver `../Monorepo-Structure.md` seção do bloco correspondente para localização e convenções.
