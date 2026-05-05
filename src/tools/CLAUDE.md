# tools/ — Ações Disponíveis para o Claude

Tools são funções que o Claude chama via tool use durante a inferência.
São executadas pelo HarnessLoop após o Claude retornar `tool_calls`.

## Interface obrigatória
```typescript
interface Tool {
  name: string               // snake_case — ex: 'save_lead_info'
  description: string        // instrução clara para o Claude saber quando usar
  inputSchema: JSONSchema    // schema dos parâmetros (validado antes de executar)
  execute(args: unknown, ctx: HarnessContext): Promise<ToolResult>
}

interface ToolResult {
  success: boolean
  data?: unknown             // retornado ao Claude como tool_result
  error?: string             // mensagem de erro legível pelo Claude
}
```

## Registrar nova tool
1. Criar `tools/minha-tool.ts` implementando `Tool`.
2. Importar e adicionar em `tools/registry.ts` no array `ALL_TOOLS`.
3. Adicionar o nome no array `tools_enabled` default de `agent_configs`.
4. Atualizar a seção 3.2 de `../../../Harness-Architecture.md`.

## O que tools PODEM fazer
- Ler do banco via Drizzle (`db` de `../db/client`) — queries, lookups
- Escrever no banco via Drizzle — INSERT, UPDATE
- Ler configurações do `agent_configs`
- Emitir eventos no EventBus
- Chamar APIs externas (ex: Zapster, futuro Google Calendar)

## O que tools NÃO PODEM fazer
- Enviar mensagens ao cliente via `zapsterClient` — isso é responsabilidade dos hooks
- Chamar o LLM diretamente
- Modificar o contexto do turno (só hooks fazem isso)
- Fazer short-circuit do turno
- Editar `db/schema.ts` (é gerado)

## Boas práticas de `description`
A `description` é o que o Claude lê para decidir se usa a tool.
- Seja específico sobre QUANDO usar: "Chame quando o usuário confirmar a data do evento"
- Seja específico sobre o que NÃO fazer: "Não chame se o usuário ainda não confirmou o evento"
- Use exemplos no `description` quando o critério for ambíguo

## Exemplo completo de tool
```typescript
// tools/example-tool.ts
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { leads } from '../db/schema'
import { eventBus } from '../harness/event-bus'
import type { Tool, HarnessContext, ToolResult } from '../types'

export const exampleTool: Tool = {
  name: 'example_tool',
  description: 'Chame quando o usuário confirmar X. Não chame se Y.',
  inputSchema: {
    type: 'object',
    properties: {
      leadId: { type: 'string', description: 'UUID do lead' },
      value: { type: 'string', description: 'Valor a salvar' }
    },
    required: ['leadId', 'value']
  },

  async execute(args: { leadId: string; value: string }, ctx: HarnessContext): Promise<ToolResult> {
    try {
      await db.update(leads)
        .set({ someField: args.value })
        .where(eq(leads.id, args.leadId))
      eventBus.emit('tool_call', { tool: 'example_tool', leadId: args.leadId })
      return { success: true, data: { updated: true } }
    } catch (err) {
      return { success: false, error: 'Não foi possível salvar o dado.' }
    }
  }
}
```

## Tools existentes e o que persistem
| Tool | Persiste em |
|---|---|
| `save_lead_info` | `leads` (event_type, event_date, guest_count, budget) |
| `classify_lead` | `leads.classification` |
| `get_booking_link` | — (read-only: `hook_params.booking_link`) |
| `schedule_visit` | `leads.visit_scheduled_at` |
| `get_pricing_info` | — (read-only: `knowledge_articles`) |
| `add_tag` | `lead_tags` |
| `transfer_to_human` | `leads.is_human_active = true` |
| `remember_fact` | `contact_facts` |
| `create_task` | `tasks` |
