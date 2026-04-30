# ADR 0006 — Field Death Detector (Onda 5 / Vácuo 5)

**Data:** 2026-04-29
**Status:** Aceito
**Refs:** PLANO-EXECUCAO-AGENTE Onda 5; ADR 0002 (Finding v2); ADR 0004 (FlagDeadBranch); ADR 0005 (AdversarialConfirmer)

## Contexto

Vácuo 5 — o último dos 5 vácuos do plano da plataforma. Auditoria cruzada de 8 produtos (CodeQL, Sourcegraph, Sonar, Endor, Sentry, Datadog, Snyk, knip) confirmou: **nenhum emite o sinal "seu schema acumula colunas/campos mortos"**.

- Schema linters (sqlfluff, knip) olham só estrutura (column existe? está bem nomeada?).
- Observability tools (Datadog, Sentry) olham só volume de request/erro — não correlacionam com a definição do schema.
- Coverage tools (Codecov) medem código executado, não dado populado.

Ninguém **cruza catálogo declarado × payload runtime**. O sintoma operacional é universal: bases relacionais antigas acumulam colunas que existem no DDL mas zero query inserciona/lê (legacy, refactor incompleto, DTO órfão). Idem GraphQL types que ninguém consulta há meses.

## Decisão

`FieldDeathDetectorService` recebe dois inputs:

1. `schemaFields[]` — catálogo declarado: `{ entity, fieldName, kind, source?, repo?, ref? }`. Vem tipicamente de `nup-sentinel-manifest` (drizzle dump, GraphQL schema, OpenAPI spec).
2. `observedFields[]` — o que o runtime de fato populou: `{ entity, fieldName, lastSeenAt?, occurrenceCount? }`. Vem de `nup-sentinel-probe` (request/response sampling).

### Regras de decisão

| Cenário | Ação | Severity |
|---|---|---|
| declarado AND observado (`occurrenceCount > 0` ou presente sem count) | no-op (alive) | — |
| declarado AND nunca observado | emit `field_death/dead_field` | medium |
| declarado AND observado com `occurrenceCount = 0` | emit `field_death/dead_field` (Stale) | low |
| observado AND não declarado | no-op (out of scope — orphan field é outro detector futuro) | — |

`symbolRef.identifier = ${entity}.${fieldName}`. `source = 'auto_manifest'` no payload default; quando o correlator está ativo e há evidências de outras fontes (probe runtime, etc.), o merge cross-source promove `confidence` para `double_confirmed` ou `triple_confirmed`.

### Configuração

| Flag | Default | Razão |
|---|---|---|
| `caseInsensitiveEntity` | `true` | ORM (PascalCase) vs SQL dump (snake_case) frequentemente discordam de case da entity. |
| `caseInsensitiveField` | `false` | Field names tendem a ser consistentes dentro de um stack. Ativar quando o stack mistura camelCase/PascalCase. |
| `allowlistedEntities` | `[]` | Tabelas soft-deleted ou audit trails que o scanner pega mas o runtime nunca toca. |

### Proteções

1. **Tenant isolation:** `organizationId` propagado para o Finding; correlator merge é gated por `(orgId, projectId, type, symbolRef.identifier)`.
2. **Dedup de schema:** mesma `(entity, field)` listada N vezes no input vira 1 finding (drizzle dump pode listar a mesma coluna em múltiplos arquivos).
3. **Malformed-safe:** schema entries sem `entity` ou `fieldName` são puladas com `stats.skippedMalformed` — não crasha o run.
4. **Sem dependência de correlator:** se `correlator` não for injetado, cria 1 finding por dead field (sem dedup cross-source). Cliente paga em ruído mas o detector roda.

### Endpoint

`POST /api/projects/:projectId/field-death/run`
Body: `{ schemaFields: SchemaField[], observedFields: ObservedField[], config?: FieldDeathConfig }`. Retorna `{ sessionId, stats, emittedCount, emitted[] }`.

Gated por `sentinel.findings.write` + ReBAC project membership.

## Alternativas

**Tentar inferir `schemaFields` do próprio Probe (runtime parsing dos response payloads) (descartado):**
Probe vê só o que o runtime emite. Se o campo está dead, Probe **nunca** o vê — exatamente o caso que estamos tentando detectar. O catálogo precisa vir de uma fonte estática (Manifest), não da observação.

**Heurística de "campo always null" via Probe sozinho (descartado):**
Probe poderia emitir "vi 10k responses, campo X foi null em 100% dos casos" como dead. Problema: confunde campo opcional não-populado-no-período com campo morto de fato. Sem o lado declarado (do Manifest), não dá pra distinguir "ninguém populou" de "ninguém leu".

**Fazer cross-source merge dentro do detector (descartado):**
Reinventaria o `CorrelatorService`. Ele já existe e já faz exatamente isso. O detector só emite payload bem-formado e deixa o correlator decidir merge.

**Severity = high para todos (descartado):**
Field morto raramente é incidente; é dívida técnica gradual. Manter `medium` (nunca observado) e `low` (stale com count=0) calibra com `flag_dead_branch` (medium) e evita alert fatigue.

## Consequências

**Positivas:**

- Sentinel agora fecha os 5 vácuos do plano. **Tese da plataforma completa.**
- Cliente recebe lista acionável de colunas/campos pra dropar — historicamente um custo invisível que ninguém mede.
- Cross-source via correlator: quando Manifest E Probe E (futuro) Code apontam pro mesmo `User.fax`, finding sobe pra `triple_confirmed`. Cliente sabe que pode dropar com segurança.

**Negativas:**

- Depende de Manifest exportar catálogo de schema confiável. Stacks sem Manifest deployado não conseguem rodar este detector.
- "Field nunca observado" precisa de janela mínima de runtime — recomendar 30+ dias de Probe rodando antes de emitir. Sem isso, dispara em campo recém-deploiado e ninguém ainda chamou.
- Não cobre observed-but-not-declared (orphan field). Esse vira detector próprio se demanda real aparecer.

## Próximos passos

- Probe adversarial pra `dead_field`: emitir um INSERT de teste populando o campo e validar que nenhum consumer downstream falha (i.e., realmente seguro dropar).
- Integração com `nup-sentinel-manifest`: emitter automático que faz POST em `/api/findings/ingest` com schemaFields + Probe POSTando observedFields. Detector roda em cron a partir do estado consolidado.
- Janela temporal explícita: aceitar `windowDays` no body e rejeitar runs com janela < 7d (proteção contra falso positivo em deploy fresco).
