# ADR 0005 — Adversarial Confirmer (Onda 4 / Vácuo 4)

**Data:** 2026-04-30
**Status:** Aceito
**Refs:** PLANO-EXECUCAO-AGENTE Onda 4; ADR 0002 (Finding v2)

## Contexto

Auditoria de 8 produtos comerciais (CodeQL, Sourcegraph, Sonar, Endor, Sentry, Datadog, Snyk, knip) confirmou Vácuo 4: nenhum executa um teste **adversarial automatizado** que tente reproduzir o bug que uma análise estática sugere.

Sintoma operacional: SAST emite milhares de findings; equipe queima horas triando falsos positivos. Sem prova ativa, cada finding é "talvez".

## Decisão

`AdversarialConfirmerService` opera como um **registry de probes** indexado por `Finding.subtype`. Cada probe é uma função `(finding, context) → ProbeResult` que tenta reproduzir o bug:

- `passed: true` → finding é **promovido** para `confidence: 'adversarial_confirmed'` (sticky — nunca regride). Evidence `auto_qa_adversarial` é adicionado.
- `passed: false` → finding ganha evidence `auto_qa_adversarial` com prefixo `DISCONFIRMED:`. Confidence **não muda** (manual review ainda possível).
- `null/undefined` retornado → "probe não se aplica a este finding" → skip silencioso.
- Probe lança exceção → skip com `reason: 'probe_error'`. Run nunca crasha.

### Probes que ship out-of-the-box

| Subtype | Probe | Lógica |
|---|---|---|
| `unprotected_handler` | `HttpProbe` | Faz a request real ao endpoint **sem header de Authorization**. 2xx → reproduzido (handler unprotected). 401/403 → static was wrong (auth via runtime). Outros status → inconclusivo, skip. |

Demais subtypes (`orphan_perm`, `dead_role`, `triple_orphan`, `dead_flag`, `orphan_flag`) ficam sem probe registrado — emitem `reason: 'no_probe_for_subtype'` na coluna `skipped[]`. **Nunca fabricam evidence.**

### Proteções

1. **Tenant isolation:** findings de outra `organizationId` são puladas na iteração.
2. **Idempotência:** findings já em `adversarial_confirmed` são puladas com `reason: 'already_confirmed'`. Re-runs não duplicam.
3. **Timeout-bounded:** `HttpProbe` aborta após `timeoutMs` (default 5s).
4. **Sem credenciais:** probe HTTP NUNCA envia `Authorization` — é exatamente o ponto.

### Endpoint

`POST /api/projects/:projectId/adversarial-confirm/run`
Body opcional: `{ context: { baseUrl: 'https://app.example.com' } }`. Retorna confirmed + disconfirmed + stats + skipped reasons.

Gated por `sentinel.findings.write` + ReBAC project membership.

## Alternativas

**Migrar o markdown vivo do agente QA pra repo dedicado `nup-sentinel-qa` (descartado por ora):**
O markdown em `easynup/.github/agents/easynup-test-sentinel.agent.md` é um prompt rico de 14 dimensões — útil pra investigações narrativas, mas overkill pro confirmer adversarial cujo trabalho é pontual ("reproduz ou não"). Manter o markdown como ferramenta separada (subagent Claude); o confirmer aqui é determinístico. Repo dedicado vira issue futura quando houver demanda real.

**Confiar só em probe runtime (Probe) pra confirmar (descartado):**
Probe diz "essa rota nunca foi chamada", não "essa rota aceita unauthenticated". A confirmação adversarial é um teste **executado**, não uma observação passiva.

**Combinar adversarial com diagnostic AI (descartado por ora):**
Tentação de pedir pro Claude diagnosticar o finding ao invés de fazer probe HTTP. Rejeitado: Claude alucina prova; HTTP request é determinístico e cheap. AI fica pra triage/explanation, não pra confirmação.

## Consequências

**Positivas:**

- Finding com `confidence: adversarial_confirmed` é a evidência mais forte que Sentinel emite. Cliente sabe que SOMOS reproduzíveis.
- Probe registry é extensível — novos subtypes ganham probes sem mexer no service.
- Disconfirm é tão importante quanto confirm: cliente sabe quando o static foi falso positivo.

**Negativas:**

- Probe HTTP exige `baseUrl` em `context` — sem isso, run skipa. Operador precisa configurar deployments-target.
- Probes são side-effecting (HTTP requests). Cliente precisa autorizar Sentinel a tocar o ambiente alvo.
- Subtypes sem probe registrado nunca chegam a `adversarial_confirmed`. Próxima onda: probes pra `dead_role` (consultar Identify p/ contagem de users), `dead_flag` (consultar flag system), etc.

## Próximos passos

- Probe pra `orphan_perm`: chamar Identify e verificar se a permissão está realmente referenciada em algum role/profile.
- Probe pra `dead_role`: validar via Identify que o role tem 0 users ativos no período.
- Probe pra `dead_flag`: consultar flag system (LaunchDarkly/etc) e confirmar status real.
- Migrar prompts ricos do markdown vivo pra `nup-sentinel-qa` repo dedicado quando houver caso de uso narrativo (LLM-driven investigation).
