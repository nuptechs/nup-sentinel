# ADR 0004 — Flag × AST dead-branch detector (Onda 3 / Vácuo 3)

**Data:** 2026-04-30
**Status:** Aceito
**Refs:** PLANO-EXECUCAO-AGENTE Onda 3; ADR 0002 (Finding v2)

## Contexto

Auditoria de 8 produtos comerciais (CodeQL, Sourcegraph, Sonar, Endor, Sentry, Datadog, Snyk, knip) confirmou Vácuo 3: nenhum cruza **inventário de feature flags × AST do código** para detectar branches gated por flags forever-dead.

O sintoma típico:

```javascript
if (await flagClient.isEnabled('show_new_dashboard')) {
  return <NewDashboard />;  // ← flag was kill-switched 18 months ago,
                            //   but the code is still here
} else {
  return <OldDashboard />;  // ← prod ALWAYS returns this
}
```

Sem cruzamento explícito flag × código:

- Linters (knip, ts-prune, ESLint) não conhecem flag systems.
- Static analyzers (Sonar, CodeQL) não conhecem o estado das flags.
- Flag systems (LaunchDarkly, Statsig, OpenFeature) sabem qual flag está dead, mas não sabem onde ela é referenciada no código.

A consequência operacional é dívida acumulada: branches mortos persistem por anos até refactors arqueológicos.

## Decisão

Adotar `FlagDeadBranchDetectorService` no nup-sentinel como cruzador canônico de dois inventários:

1. **Flag inventory** — emitido por adapter externo (LaunchDarkly export, env-vars scanner, hardcoded constants extractor). Cada record:
   ```
   { key, status: 'live'|'dead'|'orphan'|'unknown', lastEnabledAt?, environments?, source? }
   ```

2. **Flag-guarded branches** — emitido por `nup-sentinel-code` AST analyzer. Cada record:
   ```
   { flagKey, file, line, kind: 'if'|'else'|'switch_case'|'ternary'|'expression_short_circuit', repo?, ref?, branchSnippet? }
   ```

### Regras de emissão

| flag.status | Ação |
|---|---|
| `live` | nenhuma emissão |
| `dead` | emite `flag_dead_branch / dead_flag` (severity=medium) |
| `orphan` | emite `flag_dead_branch / orphan_flag` (severity=low) |
| `unknown` | nenhuma emissão (don't speculate) |
| (flag não está no inventory) | emite `orphan_flag` (the branch references something that doesn't exist anywhere) |

`status='unknown'` é intencionalmente conservador: emitir um finding `flag_dead_branch` com base em dados parciais é pior que silêncio — alarme falso destrói confiança no produto.

### symbolRef canonical

Cada finding leva `symbolRef = { kind: 'file', identifier: '<file>:<line>', repo, ref }`. Isso permite:

- Dedup pelo correlator quando outro source aponta o mesmo branch.
- Crossing com finding de `auto_probe_runtime` → confidence sobe pra `double_confirmed` quando Probe confirma "esse arquivo nunca foi atingido na linha N nos últimos 90 dias".

### Integração com correlator

Quando um `CorrelatorService` é injetado no detector, emissões fluem por `correlator.ingest()` em vez de `storage.createFinding`. Isso permite que múltiplas execuções do detector (após inventário atualizado) atualizem o mesmo finding canonical em vez de criar duplicatas.

Sem correlator (modo standalone), o detector cria um finding por branch. Modo aceitável quando o orquestrador externo controla deduplicação por outra via.

## Alternativas

**Bumpar nup-sentinel-code pra detectar flag death internamente (descartado):**
Acoplaria o módulo Code ao flag system específico do cliente (LaunchDarkly tem API distinta de Statsig, ConfigCat, OpenFeature). Mantemos Code como AST-only e Sentinel como o cruzador.

**Usar runtime evidence (Probe) sozinho pra inferir flag death (descartado):**
Probe sabe que um branch nunca foi executado, mas não sabe se isso é por flag dead ou por feature legitimamente raro. Cruzar é o sinal forte.

**Emitir como `dead_code` em vez de novo `flag_dead_branch` (descartado):**
`dead_code` cobre símbolos sem caller estático. `flag_dead_branch` é semanticamente diferente — o código TEM caller estático (a condição da flag), só não é executável. Discriminar facilita triage e remediation distinta.

## Consequências

**Positivas:**

- Vácuo 3 fechado. Cliente recupera dezenas a centenas de branches mortos com um único run.
- Severity gradient (`dead`=medium, `orphan`=low, `unknown`=skip) garante triagem útil sem ruído.
- Detector é puro — aceita inputs in-memory, não depende de schema de flag system específico.

**Negativas:**

- Depende de exporter externo emitir o flag inventory. Sem ele, o detector não tem o que comparar. Plano: documentar contrato em `docs/integrations/flag-inventory-contract.md` e providenciar adapter LaunchDarkly como reference impl em onda futura.
- AST analyzer em `nup-sentinel-code` ainda precisa identificar flag-guarded branches. Hoje o módulo só faz import graph; ampliar pro AST com type-checker é trabalho de Onda 3 fase B (Codelens deep mode).

**Próximos passos imediatos:**

- Adapter LaunchDarkly (e possivelmente OpenFeature) que produz `FlagRecord[]` e POSTa `/api/findings/ingest`. Issue separada.
- Detector `nup-sentinel-code` que extrai branches gated por flags via TS AST visitor. Issue separada (Codelens deep mode).
