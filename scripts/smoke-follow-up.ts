// scripts/smoke-follow-up.ts
//
// SMOKE E2E PROGRAMÁTICO (Bloco 7 — feature `follow-up-pendente`, task #33).
//
// Smoke mínimo (modo econômico): cobre 6 cenários DETERMINÍSTICOS focados nas
// funções puras dos Blocos 2-5. Validação E2E real do checker + escalação
// acontece no Bloco 9 (deploy + smoke real em prod).
//
// Cenários:
//   C1. Happy renderer        — detectarCategoriaPorRegex + renderFollowUpMessage
//                                produz exatamente os 5 outputs aprovados em D7'.
//   C2. Skip handoff_blocked  — canSendFollowUp retorna {allowed:false, reason:'handoff_blocked'}.
//   C3. Skip outside_hours    — isWithinBusinessHours(20:01 BRT) === false.
//   C4. Skip max_attempts_24h — canSendFollowUp com 2 tentativas nas últimas 24h.
//   C5. Skip cooldown_active  — canSendFollowUp com tentativa há 30min (< 120min).
//   C6. Escalation trigger    — shouldEscalate(attemptNumber=2) === true;
//                                shouldEscalate(1) === false.
//
// Rodar:
//   npx tsx scripts/smoke-follow-up.ts
//
// Output: tabela final PASS/FAIL por cenário + soma global. Exit 0 (PASS) / 1 (FAIL).
//
// NÃO COBERTO POR ESTE SMOKE (intencional):
//   - runFollowUpChecker integração completa (requer Supabase real + fixtures);
//     validado via smoke real em prod (Bloco 9).
//   - transferToHumanStandalone integração (idem).
//   - Admin /reativar-followup E2E (idem — validado via comando real em prod).
//   - Response-tracker (FORA DO ESCOPO desta task — não há task numerada para criá-lo).

import {
  detectarCategoriaPorRegex,
  extrairUltimaPergunta,
} from '../src/utils/follow-up-question';
import {
  isFallbackName,
  renderFollowUpMessage,
} from '../src/templates/follow-up-message';
import {
  canSendFollowUp,
  isWithinBusinessHours,
  shouldEscalate,
} from '../src/rules/follow-up-rules';
import type { FollowUpConfig, FollowUpTemplates } from '../src/config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Tabela de resultados
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  name: string;
  pass: number;
  fail: number;
  status: 'PASS' | 'FAIL';
}

const results: ScenarioResult[] = [];
let currentScenario: ScenarioResult | null = null;

function startScenario(id: string, name: string): void {
  currentScenario = { id, name, pass: 0, fail: 0, status: 'PASS' };
  console.log(`\n── Cenário ${id}: ${name} ──`);
}

function endScenario(): void {
  if (!currentScenario) return;
  currentScenario.status = currentScenario.fail === 0 ? 'PASS' : 'FAIL';
  results.push(currentScenario);
  currentScenario = null;
}

function assert(cond: boolean, name: string, detail?: unknown): void {
  if (!currentScenario) throw new Error('assert called outside scenario');
  if (cond) {
    currentScenario.pass++;
    console.log(`  PASS  ${name}`);
  } else {
    currentScenario.fail++;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES_LITERAIS: FollowUpTemplates = {
  tipo_evento:
    'Então, qual tipo de evento você está organizando? Casamento, formatura, aniversário...? Pergunto isso porque cada tipo tem necessidades específicas e quero montar a proposta ideal para você 😊',
  data:
    'E aí, já tem uma data em mente para o evento? É importante saber isso para eu verificar a disponibilidade do espaço e garantir que consigamos reservar para você 😊',
  convidados:
    'Quantos convidados você está pensando em receber? Essa informação é essencial para eu sugerir o melhor espaço e configuração para o seu evento 😊',
  orcamento:
    'Qual faixa de investimento você está considerando? Com essa informação consigo montar uma proposta que caiba no seu planejamento 😊',
  generico:
    'Conseguiu pensar sobre {{pergunta_extraida}}? Essa informação vai me ajudar a preparar tudo certinho para você 😊',
};

const CONFIG_DEFAULT: FollowUpConfig = {
  enabled: true,
  threshold_minutes: 30,
  max_attempts_per_24h: 2,
  cooldown_minutes: 120,
  business_hours: {
    start: '09:00',
    end: '20:00',
    timezone: 'America/Sao_Paulo',
  },
  rate_limit_sleep_ms: 1000,
  cron_interval_ms: 600_000,
  templates: TEMPLATES_LITERAIS,
  escalation_support_template: '⏰ Lead inativo — {{nome}} ({{whatsapp}})',
};

// ─────────────────────────────────────────────────────────────────────────────
// C1 — Happy renderer (5 categorias)
// ─────────────────────────────────────────────────────────────────────────────

function scenarioC1(): void {
  startScenario('C1', 'Happy renderer — 5 categorias');

  // C1.1: tipo_evento detectado por regex.
  const cat1 = detectarCategoriaPorRegex('Qual o tipo do evento?');
  assert(cat1 === 'tipo_evento', 'detectarCategoria("Qual o tipo do evento?") = tipo_evento', cat1);

  const out1 = renderFollowUpMessage({
    contactName: 'Maria',
    categoria: 'tipo_evento',
    templates: TEMPLATES_LITERAIS,
  });
  assert(
    out1.startsWith('Oi Maria! Então, qual tipo de evento você está organizando?'),
    'renderFollowUpMessage(tipo_evento) prefixado com "Oi Maria!"',
    out1.slice(0, 80),
  );

  // C1.2: data.
  const cat2 = detectarCategoriaPorRegex('Já tem uma data em mente?');
  assert(cat2 === 'data', 'detectarCategoria("Já tem uma data") = data', cat2);

  // C1.3: convidados.
  const cat3 = detectarCategoriaPorRegex('Quantos convidados você espera?');
  assert(cat3 === 'convidados', 'detectarCategoria("Quantos convidados") = convidados', cat3);

  // C1.4: orcamento.
  const cat4 = detectarCategoriaPorRegex('Qual a faixa de investimento?');
  assert(cat4 === 'orcamento', 'detectarCategoria("faixa de investimento") = orcamento', cat4);

  // C1.5: generico — fallback + extrairUltimaPergunta.
  const cat5 = detectarCategoriaPorRegex('Vocês querem cardápio veggie?');
  assert(cat5 === null, 'detectarCategoria("cardápio veggie?") = null (cai em generico via estado/fallback)', cat5);

  const pergunta = extrairUltimaPergunta('Ótimo! E quantos convidados você espera?');
  assert(
    pergunta === 'quantos convidados você espera',
    'extrairUltimaPergunta(exemplo Sergio) = "quantos convidados você espera"',
    pergunta,
  );

  const out5 = renderFollowUpMessage({
    contactName: 'Maria',
    categoria: 'generico',
    perguntaExtraida: pergunta,
    templates: TEMPLATES_LITERAIS,
  });
  assert(
    out5 === 'Oi Maria! Conseguiu pensar sobre quantos convidados você espera? Essa informação vai me ajudar a preparar tudo certinho para você 😊',
    'renderFollowUpMessage(generico) interpola pergunta_extraida + prefixo',
    out5,
  );

  // C1.6: hotfix UX — nomes "fallback" omitem o nome (usa "Oi!" puro).
  assert(isFallbackName('WhatsApp 5519997124472') === true, 'isFallbackName("WhatsApp 5519...") = true (Zapster default)');
  assert(isFallbackName('5519997124472') === true, 'isFallbackName("5519997124472") = true (só dígitos)');
  assert(isFallbackName('') === true, 'isFallbackName("") = true (vazio)');
  assert(isFallbackName('Maria') === false, 'isFallbackName("Maria") = false (nome real)');
  assert(isFallbackName(null) === true, 'isFallbackName(null) = true');

  const outFallback = renderFollowUpMessage({
    contactName: 'WhatsApp 5519997124472',
    categoria: 'tipo_evento',
    templates: TEMPLATES_LITERAIS,
  });
  assert(
    outFallback.startsWith('Oi! Então,'),
    'renderFollowUpMessage(fallback name) = "Oi! Então..." (sem nome artificial)',
    outFallback.slice(0, 30),
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 — Skip handoff_blocked
// ─────────────────────────────────────────────────────────────────────────────

function scenarioC2(): void {
  startScenario('C2', 'Skip handoff_blocked');

  const decision = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: false,
      isHumanActive: true,
      handoffAssumedAt: new Date(),
    },
    null,
    CONFIG_DEFAULT,
  );
  assert(decision.allowed === false, 'canSendFollowUp(handoff blocked) = !allowed', decision);
  assert(
    decision.allowed === false && decision.reason === 'handoff_blocked',
    'reason = handoff_blocked',
    decision,
  );

  // Caso oposto: handoff_assumed_at NULL (modo assistido) ainda permite.
  const decision2 = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: false,
      isHumanActive: true,
      handoffAssumedAt: null,
    },
    null,
    CONFIG_DEFAULT,
  );
  assert(decision2.allowed === true, 'canSendFollowUp(assisted mode) = allowed (defesa em profundidade do response-guard)', decision2);

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// C3 — Skip outside_business_hours
// ─────────────────────────────────────────────────────────────────────────────

function scenarioC3(): void {
  startScenario('C3', 'Skip outside_business_hours');

  // 2026-05-17 23:01 UTC = 20:01 BRT (timezone -03:00) — fora da janela 9-20.
  const at2001BRT = new Date('2026-05-17T23:01:00Z');
  assert(
    isWithinBusinessHours(at2001BRT, CONFIG_DEFAULT.business_hours) === false,
    'isWithinBusinessHours(20:01 BRT) = false',
  );

  // 2026-05-17 14:00 UTC = 11:00 BRT — dentro da janela.
  const at1100BRT = new Date('2026-05-17T14:00:00Z');
  assert(
    isWithinBusinessHours(at1100BRT, CONFIG_DEFAULT.business_hours) === true,
    'isWithinBusinessHours(11:00 BRT) = true',
  );

  // Borda: exatamente 20:00 BRT — semi-aberto excluiu.
  const at2000BRT = new Date('2026-05-17T23:00:00Z');
  assert(
    isWithinBusinessHours(at2000BRT, CONFIG_DEFAULT.business_hours) === false,
    'isWithinBusinessHours(20:00 BRT exato) = false (semi-aberto)',
  );

  // Borda: exatamente 09:00 BRT — inclui.
  const at0900BRT = new Date('2026-05-17T12:00:00Z');
  assert(
    isWithinBusinessHours(at0900BRT, CONFIG_DEFAULT.business_hours) === true,
    'isWithinBusinessHours(09:00 BRT exato) = true (inclui o start)',
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// C4 — Skip max_attempts_24h
// ─────────────────────────────────────────────────────────────────────────────

function scenarioC4(): void {
  startScenario('C4', 'Skip max_attempts_24h');

  const NOW = new Date('2026-05-17T15:00:00Z');
  const SIX_HOURS_AGO = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);

  // 2 tentativas nas últimas 6h → skipa.
  const decision = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: false,
      isHumanActive: false,
      handoffAssumedAt: null,
    },
    {
      id: 'fake-attempt-id',
      contactId: 'fake-contact',
      attemptNumber: 2,
      sentAt: SIX_HOURS_AGO,
    },
    CONFIG_DEFAULT,
    NOW,
  );
  assert(decision.allowed === false, 'canSendFollowUp(2 attempts 6h ago) = !allowed', decision);
  assert(
    decision.allowed === false && decision.reason === 'max_attempts_24h',
    'reason = max_attempts_24h',
    decision,
  );

  // 2 tentativas há 25h — janela passou; agora o cooldown decide:
  // cooldown_minutes = 120; 25h >> 120min → cooldown OK; allowed = true.
  const TWENTY_FIVE_HOURS_AGO = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
  const decision2 = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: false,
      isHumanActive: false,
      handoffAssumedAt: null,
    },
    {
      id: 'old-attempt',
      contactId: 'fake-contact',
      attemptNumber: 2,
      sentAt: TWENTY_FIVE_HOURS_AGO,
    },
    CONFIG_DEFAULT,
    NOW,
  );
  assert(decision2.allowed === true, 'canSendFollowUp(2 attempts 25h ago) = allowed (janela 24h passou)', decision2);

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// C5 — Skip cooldown_active
// ─────────────────────────────────────────────────────────────────────────────

function scenarioC5(): void {
  startScenario('C5', 'Skip cooldown_active');

  const NOW = new Date('2026-05-17T15:00:00Z');
  const THIRTY_MIN_AGO = new Date(NOW.getTime() - 30 * 60 * 1000);

  // 1 tentativa há 30min < cooldown_minutes (120) → skipa por cooldown.
  const decision = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: false,
      isHumanActive: false,
      handoffAssumedAt: null,
    },
    {
      id: 'recent-attempt',
      contactId: 'fake-contact',
      attemptNumber: 1,
      sentAt: THIRTY_MIN_AGO,
    },
    CONFIG_DEFAULT,
    NOW,
  );
  assert(decision.allowed === false, 'canSendFollowUp(1 attempt 30min ago) = !allowed', decision);
  assert(
    decision.allowed === false && decision.reason === 'cooldown_active',
    'reason = cooldown_active',
    decision,
  );

  // 1 tentativa há 130min > cooldown — agora allowed.
  const TWO_HOURS_TEN_MIN_AGO = new Date(NOW.getTime() - 130 * 60 * 1000);
  const decision2 = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: false,
      isHumanActive: false,
      handoffAssumedAt: null,
    },
    {
      id: 'old-attempt',
      contactId: 'fake-contact',
      attemptNumber: 1,
      sentAt: TWO_HOURS_TEN_MIN_AGO,
    },
    CONFIG_DEFAULT,
    NOW,
  );
  assert(decision2.allowed === true, 'canSendFollowUp(1 attempt 130min ago) = allowed (cooldown passou)', decision2);

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// C6 — Escalation trigger (shouldEscalate)
// ─────────────────────────────────────────────────────────────────────────────

function scenarioC6(): void {
  startScenario('C6', 'Escalation trigger (RF5)');

  assert(shouldEscalate(2, CONFIG_DEFAULT) === true, 'shouldEscalate(2) = true (RF5 dispara)');
  assert(shouldEscalate(1, CONFIG_DEFAULT) === false, 'shouldEscalate(1) = false (ainda pode tentar)');
  assert(shouldEscalate(3, CONFIG_DEFAULT) === true, 'shouldEscalate(3) = true (defensive — não deveria chegar aqui)');

  // Skip cenários adicionais (lead_closed, follow_up_disabled).
  const decisionClosed = canSendFollowUp(
    {
      status: 'WON',
      followUpDisabled: false,
      isHumanActive: false,
      handoffAssumedAt: null,
    },
    null,
    CONFIG_DEFAULT,
  );
  assert(
    decisionClosed.allowed === false && decisionClosed.reason === 'lead_closed',
    'canSendFollowUp(status=WON) = lead_closed',
    decisionClosed,
  );

  const decisionDisabled = canSendFollowUp(
    {
      status: 'OPEN',
      followUpDisabled: true,
      isHumanActive: false,
      handoffAssumedAt: null,
    },
    null,
    CONFIG_DEFAULT,
  );
  assert(
    decisionDisabled.allowed === false && decisionDisabled.reason === 'follow_up_disabled',
    'canSendFollowUp(followUpDisabled=true) = follow_up_disabled',
    decisionDisabled,
  );

  endScenario();
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Smoke E2E programático — feature follow-up-pendente');
  console.log('═══════════════════════════════════════════════════════════');

  scenarioC1();
  scenarioC2();
  scenarioC3();
  scenarioC4();
  scenarioC5();
  scenarioC6();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Resultado final');
  console.log('═══════════════════════════════════════════════════════════\n');

  const totalAsserts = results.reduce((s, r) => s + r.pass + r.fail, 0);
  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  const cenariosPass = results.filter((r) => r.status === 'PASS').length;
  const cenariosFail = results.filter((r) => r.status === 'FAIL').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${icon} ${r.id}: ${r.name.padEnd(40)} ${r.pass}/${r.pass + r.fail} asserts`);
  }

  console.log(
    `\n  ${cenariosPass}/${results.length} cenários PASS · ${totalPass}/${totalAsserts} asserts PASS`,
  );

  if (totalFail > 0) {
    console.log('\n  ✗ FAIL — algum cenário não passou. Inspecione o output acima.\n');
    process.exit(1);
  }
  console.log('\n  ✓ ALL PASS\n');
  process.exit(0);
}

main();
