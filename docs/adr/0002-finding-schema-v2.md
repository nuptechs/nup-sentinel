# ADR 0002 — Schema de Finding v2 (contrato cross-source)

**Data:** 2026-04-29
**Status:** Aceito
**Refs:** PLANO-EXECUCAO-AGENTE seção 2 / Tarefa 0.2

## Contexto

O `Finding` v1 do Sentinel modelava bugs descobertos manual ou automaticamente em runtime (`auto_error`, `auto_performance`, `auto_network`). Com a adoção do Modelo B (ADR 0001), o Sentinel passa a ser o **correlator** de findings vindos de 5+ módulos heterogêneos (Code, Manifest, Probe, QA, Semantic), cada um com sua semântica e timing.

O contrato precisa:

- Distinguir **fontes** sem perder retrocompatibilidade.
- Discriminar **tipos** de problema além de bugs (dead code, permission drift, dead branch, etc).
- Permitir **correlação cross-source**: dois módulos que apontam o mesmo símbolo viram a mesma evidência consolidada.
- Carregar **confiança progressiva**: 1 source → suspeita; 3+ sources → certeza.
- Permitir **migração lazy** dos findings v1 antigos (sem dropar tabela).

## Decisão

Adotar **Schema Finding v2** como contrato imutável dentro de cada onda. Mudanças exigem bumpa de `schemaVersion` + migração documentada.

### Aditivos sobre v1

**Sources** (não removidos os v1):

- `auto_static` — emitted por `nup-sentinel-code`
- `auto_manifest` — emitted por `nup-sentinel-manifest`
- `auto_probe_runtime` — emitted por `nup-sentinel-probe`
- `auto_qa_adversarial` — emitted por `nup-sentinel-qa`
- `auto_semantic` — emitted por `nup-sentinel-semantic`

**Types** (não removidos os v1):

- `dead_code`, `permission_drift`, `flag_dead_branch`, `field_death`, `semantic_dup`, `inconsistency`

**Novos campos:**

- `subtype` (string|null) — discriminador dentro de `type` (ex: `orphan_perm`, `unprotected_handler`, `triple_orphan`).
- `confidence` (`single_source`|`double_confirmed`|`triple_confirmed`|`adversarial_confirmed`) — calculado pelo correlator a partir de `evidences[]`.
- `evidences` (Evidence[]) — observações por source: `{ source, sourceRunId?, sourceUrl?, observation, observedAt }`.
- `symbolRef` (SymbolRef|null) — `{ kind: file|function|route|permission|role|field, identifier, repo?, ref? }`. Identificador canônico para correlação.
- `schemaVersion` (string) — `"2.0.0"` em findings novos; ausência ⇒ trata como `"1.0.0"`.

### Regra de cálculo de confidence

```
1 distinct source            → single_source
2 distinct sources            → double_confirmed
3+ distinct sources           → triple_confirmed
QA confirmer succeeded        → adversarial_confirmed (orthogonal, sticky)
```

`adversarial_confirmed` não é downgradeable por novas evidências.

### Migration v1 → v2

`migrateV1ToV2(input)` é pure function aplicada lazy:

- input v2 → passa unchanged
- input null/undefined → passa unchanged
- input v1 → adiciona `schemaVersion: '2.0.0'`, `confidence: 'single_source'`, `subtype: null`, `symbolRef: null`, e converte `source/description` em uma `evidence[0]`

Storage: migration SQL `version: 5 finding_schema_v2` adiciona colunas `schema_version`, `subtype`, `confidence`, `evidences`, `symbol_ref` em `sentinel_findings`. Linhas pré-existentes ganham `schema_version='1.0.0'` no UPDATE inicial; reads aplicam `migrateV1ToV2` no `_mapFinding`.

### Endpoint de ingestão

`POST /api/findings/ingest` aceita objeto único ou array. Validação Zod via `FindingV2Schema`. v1 payloads são auto-migrados antes da validação. Retorna `{ success, data, acceptedCount, rejectedCount, rejected }`.

## Alternativas

**Bumpar v1 inplace (descartado):** quebraria consumers do SDK (`@nuptechs/sentinel`) e da MCP API. Rejeitado por princípio inegociável "nunca apagar capacidade existente".

**Discriminated union por type (descartado):** tornaria o schema mais rígido e difícil de estender. Optei por shape unificado com fields opcionais — correlator decide significado por `(type, subtype, source)`.

**Embeddings inline em findings (descartado):** custo de armazenamento e latência. Embeddings vivem em `nup-sentinel-semantic` (Onda 6) e referenciam findings via `symbolRef`.

## Consequências

**Positivas:**

- Multiple-source correlation via `symbolRef` virou first-class. Probabilidade de bug real cresce com cada source independente.
- v1 consumers continuam funcionando sem mudança.
- Storage path migrou aditivamente — zero downtime.

**Negativas:**

- Code path levemente mais complexo: leitor precisa rodar `migrateV1ToV2` para findings antigos.
- Index novo em `(symbol_ref->>'identifier')` adiciona overhead em INSERT — aceitável para o volume esperado (correlator não é hot path).

**Próximos passos:**

- Onda 1 (Permission Drift) emite findings v2 com `subtype: orphan_perm | unprotected_handler | dead_role`.
- Onda 2 (Triple-orphan) emite findings v2 com `subtype: triple_orphan` e `confidence` calculada via correlator.
- Onda 4 (QA confirmador) chama `markAdversarialConfirmed()` quando o teste reproduz o bug.
