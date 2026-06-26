# Configuração de Webhook — Zapster

## Retry de Webhooks (Recomendado)

Para garantir que mensagens não se percam durante restarts/deploys do worker, configure **retry automático** no painel da Zapster.

### Requisitos

| Parâmetro | Valor Recomendado |
|-----------|-------------------|
| **Condições de retry** | HTTP 5xx, timeout, connection refused |
| **Número de tentativas** | 3 |
| **Backoff** | Exponencial: 5s, 15s, 45s |

### Justificativa

Durante deploys (pm2 reload) ou restarts, o worker pode ficar indisponível por alguns segundos. Sem retry, webhooks que chegam nessa janela são perdidos → mensagens do cliente não são processadas.

Com retry configurado:
- ✅ Zapster retenta automaticamente após falha
- ✅ Mensagens chegam assim que o worker volta
- ✅ Zero perda de dados durante manutenção

### Como Configurar

1. Acesse o painel da Zapster
2. Vá em **Configurações de Webhook** (ou equivalente)
3. Habilite **Retry automático**
4. Configure:
   - Condições: 5xx, timeout, connection refused
   - Tentativas: 3
   - Intervalo: 5s, 15s, 45s (exponencial)

### Validação

Após configurar, teste:
1. Pare o worker: `pm2 stop angelina-worker`
2. Envie mensagem no WhatsApp
3. Aguarde ~10s
4. Inicie o worker: `pm2 start angelina-worker`
5. Verifique se a mensagem foi processada (deve aparecer nos traces)

> Nota: o endpoint `GET /healthz` do worker retorna `503` quando DB/Redis estão indisponíveis
> (readiness check). Útil para o painel da Zapster e monitoramento decidirem se a instância
> está apta a receber tráfego.

---

**Responsável:** Administrador da conta Zapster
**Prioridade:** Alta (previne perda de mensagens)
