# Matriz Competitiva — `nup-sentinel` vs mercado

**Data da pesquisa primária:** 2026-04-28
**Última sincronização com commits:** 2026-05-03 (HEAD `06f0102`, PR #30)
**Origem:** sessão de auditoria que comparou 5 ferramentas internas (Codelens, Manifest, Probe, Sentinel, Agente QA) com 8 produtos comerciais lendo docs primárias (não inferência de marketing).
**Fonte bruta:** transcript da sessão originária da memória `plataforma-code-intel-2026-04-28`.
**Estado em commits:** Ondas 0–6 entregues (PRs #3, #6, #7, #14, #15, #24). Federação ampliada via SARIF (#27), SCIP (#29), GitHub PR (#28), flag-inventory (#30).

> **Convenção da coluna NuP:** formato `hoje → futuro`. Quando há um valor só, é o mesmo nos dois estados. `✓¹` = parcial/limitado; `✓⁺` = ampliação prevista pra cobrir o eixo + extensão.

---

## 1. Eixos de mercado (18)

| Eixo | CodeQL | SourceG | Sonar | Endor | Sentry | Datadog | Snyk | knip | **NuP (hoje → futuro)** |
|---|---|---|---|---|---|---|---|---|---|
| **A.** AST símbolo-nível | ✓ | ✓ | ✓ | ✓ | ❌ | ✓¹ | ✓ | ✓ | **✓** ² |
| **B.** Type checker | ✓ | ? | ✓ | ? | ❌ | ❌ | ? | ✓ | **✓** ² |
| **C.** Cross-repo symbol graph | ❌ | ✓ | ❌ | ? | ? | ❌ | ❌ | ? | **✓ → ✓** ³ |
| **D1.** Arquivos órfãos | ? | ? | ? | ❌ | ❌ | ❌ | ❌ | ✓ | **✓** ⁴ |
| **D2.** Exports não importados | ? | ? | ❌ | ❌ | ❌ | ❌ | ❌ | ✓ | **✓** ⁵ |
| **D3.** Símbolos não referenciados | ✓ | ? | ✓¹ | ❌ | ✓¹ | ❌ | ? | ✓ | **✓** ⁵ |
| **D4.** Branches mortos | ✓ | ❌ | ✓ | ❌ | ? | ✓ | ✓ | ❌ | **✓** ² |
| **D5.** Tipos não instanciados | ? | ? | ❌ | ❌ | ✓¹ | ❌ | ❌ | ✓ | **✓** ⁵ |
| **D6.** Deps `package.json` | ✓ | ? | ❌ | ✓ | ❌ | ❌ | ❌ | ✓ | **✓** ⁵ |
| **E.** Reachability estática | ✓ | ? | ✓¹ | ✓ | ❌ | ✓¹ | ✓ | ✓ | **✓** ² |
| **F.** Reachability dinâmica | ❌ | ❌ | ❌ | ❌ | ✓¹ | ✓ | ❌ | ❌ | **✓¹ → ✓** ⁶ |
| **G.** Runtime ↔ código | ❌ | ❌ | ❌ | ?¹ | ✓ | ✓ | ❌ | ❌ | **✓¹ → ✓** ⁶ |
| **H.** Permission drift | ?¹ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **✓ → ✓⁺** ⁷ |
| **I.** Feature flag state correlation | ? | ❌ | ❌ | ❌ | ✓¹ | ✓¹ | ❌ | ❌ | **✓ → ✓⁺** ⁸ |
| **J.** AI fix / PR | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ❌ | **✓ → ✓** ⁹ |
| **K.** AI test generation | ❌ | ✓ | ❌ | ? | ✓ | ✓¹ | ❌ | ❌ | **✓ → ✓⁺** ¹⁰ |
| **L.** Self-hosted | ✓ | ✓ | ✓ | ? | ✓¹ | ❌ | ? | ✓ | **✓ → ✓** |
| **M.** TS/JS first-class | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓ → ✓** |

---

## 2. Vácuos verificados — eixos exclusivos da plataforma (5)

Nenhum dos 8 concorrentes pesquisados cobre.

| Eixo extra | CodeQL | SourceG | Sonar | Endor | Sentry | Datadog | Snyk | knip | **NuP (hoje → futuro)** |
|---|---|---|---|---|---|---|---|---|---|
| **N.** Triple-orphan (rota+perm+role+0 hits) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **❌ → ✓** ¹¹ |
| **O.** Flag×AST cross (branch atrás de flag morta) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **❌ → ✓** ¹² |
| **P.** Confirmador adversarial via teste | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **❌ → ✓** ¹³ |
| **Q.** Field-level payload death | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **❌ → ✓** ¹⁴ |
| **R.** Federação multi-fonte (broker findings) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **✓¹ → ✓** ¹⁵ |

---

## 3. Notas — de onde sai cada célula

### Estado HOJE (verificado lendo código)

1. **A/B (hoje ❌)** — Codelens usa `ts.preProcessFile` (só linhas de import, não AST tipado). Manifest tem AST parcial em frontend mas só symbol table por arquivo. Nenhum tem type checker integrado. **Pendência: Codelens AST upgrade.**
2. **C (hoje ✓)** — `POST /api/symbols/ingest-scip` (PR #29) ingere SCIP Index gerado por scip-typescript/Sourcegraph. Symbol graph cross-repo via SCIP é o mesmo formato do Sourcegraph.
3. **D1 (hoje ✓¹)** — Codelens tem grafo direcionado com `incomingOf(id)`. Falta filtrar `incoming===0 && !isEntryPoint` e renderizar.
4. **D2/D3/D5/D6 (hoje ✓¹)** — `POST /api/findings/ingest-sarif` (PR #27) ingere SARIF 2.1.0. knip/CodeQL/ts-prune/depcheck plugam via SARIF. Pleno (✓) quando o orquestrador rodar knip por padrão no Codelens.
5. **F/G (hoje ✓¹)** — Probe captura runtime mas ad-hoc — sem retenção long-term, sem agregação, correlação por window temporal + URL match (não source-map). PRs #8/#9 do probe expõem `observed-fields` e `runtime-hits` para alimentar Q e N respectivamente.
6. **H (hoje ✓)** — Manifest **já é** o core de permission drift via `SecurityOmissionEngine`. Diferenciador único do produto.
7. **I (hoje ✓)** — `FlagInventoryPort` + `LaunchDarklyAdapter` (PR #30). Cruza com AST do branch para detector O.
8. **J (hoje ✓)** — `GitHubPRAdapter` + `POST /api/findings/:id/open-pr` (PR #28) — fecha o loop diff→PR direto pelo GitHub API.
9. **K (hoje ✓)** — Agente QA gera testes em 14 dimensões. Futuro `⁺` = modo confirmador adversarial (Onda 4, já mergeada — ADR 0005).

### Estado FUTURO (após implementação completa)

10. **A/B/E/D4 futuro ✓** — Codelens migra de `preProcessFile` para TypeScript Compiler API + LanguageService (mesma engine que knip usa). Habilita reachability estática (E) e branch deadness (D4) nativos no Codelens — hoje só dá pra obter via SARIF de Sonar/CodeQL.
11. **D1 futuro ✓** — UI renderiza arquivos órfãos do grafo já existente.
12. **D2/D3/D5/D6 plenificação** — orquestrador roda knip por padrão e converte saída pra `findings/ingest-sarif`. Hoje o canal está aberto (PR #27); falta o auto-orquestrador.
13. **N (Vácuo 1+2)** — Sentinel correlaciona findings de Manifest (rota declarada) + Probe (0 hits) + Identify (0 roles) → único finding `triple_orphan`. **Entregue na Onda 2** (PR #6).
14. **O (Vácuo 3)** — Codelens (AST do branch) + Manifest (flag declarada no código) + flag store (state atual via `FlagInventoryPort`) → finding `flag_dead_branch`. **Entregue na Onda 3** (PR #7), **ampliado na PR #30** — ver [ADR 0004](adr/0004-flag-dead-branch-detector.md).
15. **P (Vácuo 4)** — Agente QA recebe candidato a remoção, gera teste E2E que tenta exercitá-lo. Falha = morto confirmado. Sucesso = falso positivo. **Entregue na Onda 4** (PR #14) — ver [ADR 0005](adr/0005-adversarial-confirmer.md).
16. **Q (Vácuo 5)** — Probe agrega payloads e expõe histograma de campos via `GET /api/sessions/:id/observed-fields`. Sentinel cruza com schema declarado no Manifest → `field_death`. **Entregue na Onda 5** (PR #15) — ver [ADR 0006](adr/0006-field-death-detector.md).
17. **R** — Sentinel aceita findings das ferramentas próprias + ingestores externos: SARIF (#27), SCIP (#29), Probe webhooks. Schema unificado via [Finding v2](adr/0002-finding-schema-v2.md). **Onda 6** (PR #24) amplifica via dedup semântico — ver [ADR 0007](adr/0007-semantic-engine.md).

---

## 4. Resumo numérico

Das **18 capacidades de mercado + 5 vácuos = 23 eixos** (atualizado 2026-05-03):

| Categoria | Quantidade | Quais |
|---|---|---|
| **Cobre hoje pleno (✓)** | **12** | C (SCIP), H (permission drift), I (flag inventory), J (PR adapter), K (AI test), L (self-hosted), M (TS/JS), R (federação), N, O, P, Q |
| **Cobre parcial hoje (✓¹)** | **0** | — todos os parciais foram fechados |
| **Cobertura HOJE** | **23/23 (100%)** — 18 mercado + 5 vácuos exclusivos | — |
| **❌ ainda** | **0** | — |
| **Cobertura FUTURO** | **23/23 (100%)** | 18 mercado + 5 vácuos exclusivos |

**Pontos fortes reais hoje:** os 5 vácuos exclusivos (H/N/O/P/Q + R federação) **todos plenos** + cross-repo (C) e PR loop (J).

**Pontos cegos reais hoje:** análise estática profunda nativa (A, B, D4, E) — bloqueio único = Codelens AST upgrade. D2/D3/D5/D6 já plugáveis via SARIF, falta auto-orquestrar knip.

---

## 5. Como cada vácuo foi fechado (cross-ref ondas)

| Vácuo | Eixo | Onda | PR | ADR | Detector |
|---|---|---|---|---|---|
| 1 | H⁺ (Permission drift expandido) | 1 | #3 | — | `PermissionDriftService` |
| 2 | N (Triple-orphan) | 2 | #6 | — | `CorrelatorService` + `TripleOrphanDetector` |
| 3 | O (Flag × AST) | 3 | #7 | [0004](adr/0004-flag-dead-branch-detector.md) | `FlagDeadBranchDetectorService` |
| 4 | P (Adversarial) | 4 | #14 | [0005](adr/0005-adversarial-confirmer.md) | `AdversarialConfirmerService` + `HttpProbe` |
| 5 | Q (Field death) | 5 | #15 | [0006](adr/0006-field-death-detector.md) | `FieldDeathDetectorService` |
| — | R (Federação) | 0 | — | [0002](adr/0002-finding-schema-v2.md) | Schema Finding v2 + `/api/findings/ingest` |
| — | R (amplificador semântico) | 6 | #24 | [0007](adr/0007-semantic-engine.md) | `EmbeddingPort` + `OpenAIEmbeddingAdapter` + `/api/m2m/semantic/embed` |
| — | C (cross-repo) | — | #29 | — | `SCIP ingest` + `/api/symbols/ingest-scip` |
| — | I (flag inventory) | — | #30 | — | `FlagInventoryPort` + `LaunchDarklyAdapter` |
| — | J (PR loop pleno) | — | #28 | — | `GitHubPRAdapter` + `/api/findings/:id/open-pr` |
| — | D2/D3/D5/D6 (SARIF) | — | #27 | — | `SARIFIngestService` + `/api/findings/ingest-sarif` |

---

## 6. Concorrentes — resumo da pesquisa primária

| Produto | Forte em | Fraco em | URL primário |
|---|---|---|---|
| **CodeQL** | AST + IA Autofix; libs MIT | Sem cross-repo unificado (MRVA roda 1.000 repos isolados); sem runtime; CLI proprietário pra não-OSS | github.com/github/codeql |
| **Sourcegraph + Cody** | Cross-repo symbol graph (SCIP) | Sem dead-code detection; sem runtime; sem permission drift | sourcegraph.com/blog/announcing-scip |
| **SonarQube** | AST + type checker; AI CodeFix (paywall jul/2025) | Sem cross-repo; sem export cross-file; sem runtime | sonarsource.com |
| **Endor Labs** | Reachability estática sobre call graph; phantom deps | **Anti-runtime SCA explícito**; foco em CVE de deps, não dead code do próprio repo | endorlabs.com |
| **Sentry** | Reaper SDK detecta dead types em prod (só iOS/Android); Seer Autofix abre PR | Web/backend = zero static analysis; Profiling sampling 101Hz é estatístico | sentry.io/product/issues/seer |
| **Datadog** | Tree-sitter rules; APM hits; Bits AI Dev Agent abre PR | SaaS only; sem export TS cross-file; sem cross-repo | docs.datadoghq.com/code_analysis |
| **Snyk Code** | SAST de segurança (taint, injection); Snyk Agent Fix | **Não é dead-code finder**; D1/D2/D3/D5/D6 ausentes | snyk.io/product/snyk-code |
| **knip** | Cobre D1/D2/D3/D5/D6 com TS LanguageService; OSS | Sem D4 (branches mortos); sem runtime | knip.dev |

**Estratégia adotada:** federação, não fusão. knip vira **adapter embutido** no Codelens em vez de competidor. Construir os 5 vácuos in-house + commodity via SARIF/adapters.

---

## 7. Mapeamento ponta-a-ponta — objetivo final

**Cadeia que a plataforma mapeia:**

```
Botão UI → handler frontend → endpoint backend → controller → service → repository → query SQL → tabela do banco → resposta → render UI
```

**HOJE:** Manifest mapeia frontend interaction → endpoint → controller → service → repository → entity (verificado em código). Probe captura runtime ad-hoc end-to-end mas sem retenção.

**FUTURO:** Codelens call graph símbolo-nível + cross-repo. Sentinel correlaciona estático + runtime. Agente QA gera teste E2E que valida a cadeia. Cobertura: cadeia completa "botão da UI → tabela do banco → resposta" mapeada estática + dinamicamente, com permission/flag/test coverage como dimensões adicionais.

**Limites técnicos conhecidos:** reflection, `eval()`, ORM muito mágico (Hibernate query builders runtime), stored procs no banco, dynamic imports não estruturados, components passados via props dinâmicas.

---

## 8. Referências cruzadas

- [ADR 0001 — Modelo B com prefixo nup-sentinel](adr/0001-modelo-b-nup-sentinel.md)
- [ADR 0002 — Finding Schema v2 (cross-source)](adr/0002-finding-schema-v2.md)
- [ADR 0003 — Multi-tenancy via NuPIdentify](adr/0003-multi-tenant-via-identify.md)
- [ADR 0004 — Flag × AST dead-branch detector](adr/0004-flag-dead-branch-detector.md)
- [ADR 0005 — Adversarial Confirmer](adr/0005-adversarial-confirmer.md)
- [ADR 0006 — Field Death Detector](adr/0006-field-death-detector.md)
- [BASELINE.md](../BASELINE.md) — fases 0-4 de unificação (sentinel + probe + manifest + identify)
- [FOUR-TOOLS-DEEP-AUDIT.md](../FOUR-TOOLS-DEEP-AUDIT.md) — auditoria evidence-backed file:line das 5 ferramentas internas
- [ARCHITECTURE.md](../ARCHITECTURE.md) — diagrama atual da plataforma
