# hooks/ — Lógica Determinística da Harness

Hooks são funções puras executadas pela harness em fases específicas do turno.
Nunca são chamados pelo Claude — são determinísticos.

## Interface obrigatória
```typescript
interface Hook {
  name: string               // identificador único (ex: 'rate-limit-guard')
  phase: HookPhase           // BEFORE_REQUEST | AFTER_MODEL | BEFORE_SEND
  execute(ctx: HarnessContext): Promise<HookResult>
}

interface HookResult {
  shortCircuit?: boolean     // true = aborta o turno imediatamente
  response?: string          // mensagem a enviar ao cliente (se shortCircuit=true)
  contextUpdate?: Partial<HarnessContext>  // dados adicionados ao contexto
}
```

## Registrar novo hook
1. Criar `hooks/meu-hook.ts` implementando `Hook`.
2. Abrir `hooks/index.ts` e adicionar na posição correta da fase correspondente.
3. Atualizar a seção 3.1 de `../../../Harness-Architecture.md`.

## Ordem de registro em `hooks/index.ts`
```
BEFORE_REQUEST: [rate-limit-guard, admin-router, load-context,
                 build-conversation-summary, after-hours-guard]
AFTER_MODEL:    [transfer-trigger, format-whatsapp]
BEFORE_SEND:    [human-delay, response-guard]   ← response-guard sempre por último
```

## O que hooks PODEM fazer
- Ler do banco via Drizzle (`db` de `../db/client`)
- Escrever no banco via Drizzle (ex: `db.update(contacts).set({ ai_state: ... })`)
- Emitir eventos no EventBus
- Enviar mensagens via `zapsterClient` (APENAS hooks de short-circuit)
- Retornar short-circuit para abortar o turno
- Modificar o contexto do turno (`contextUpdate`)

## O que hooks NÃO PODEM fazer
- Chamar o LLM diretamente
- Chamar tools diretamente
- Fazer envio de mensagem sem serem hooks de short-circuit ou `transfer-trigger`
- Mudar a ordem de execução de outros hooks
- Editar `db/schema.ts` (é gerado por `drizzle-kit pull`)

## Exemplo completo de hook
```typescript
// hooks/example-guard.ts
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { contacts } from '../db/schema'
import { eventBus } from '../harness/event-bus'
import type { Hook, HarnessContext, HookResult } from '../types'
import { HookPhase } from '../types'

export const exampleGuard: Hook = {
  name: 'example-guard',
  phase: HookPhase.BEFORE_REQUEST,

  async execute(ctx: HarnessContext): Promise<HookResult> {
    if (ctx.contact.someCondition) {
      eventBus.emit('example_blocked', { contactId: ctx.contact.id })
      return {
        shortCircuit: true,
        response: 'Não posso processar sua mensagem agora.'
      }
    }
    return {}  // sem short-circuit = continua normalmente
  }
}
```

## HarnessContext disponível no `execute()`
- `ctx.contact` — dados do contato (id, name, ai_state, phone)
- `ctx.lead` — dados do lead (id, classification, is_human_active)
- `ctx.message` — mensagem atual (text, role, media_type)
- `ctx.config` — `agent_configs` atual (hook_params, tools_enabled, etc.)
- `ctx.memory` — camadas de memória já carregadas (após `load-context`)
- `ctx.turn` — metadados do turno (startedAt, attemptCount)
