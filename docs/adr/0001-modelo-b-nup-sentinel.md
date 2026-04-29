# ADR 0001 — Modelo B com prefixo `nup-sentinel-*`

**Data:** 2026-04-29
**Status:** Aceito
**Refs:** PLANO-EXECUCAO-AGENTE Onda 0 / Tarefa 0.1; memória `nup-sentinel-plataforma-2026-04-28`

## Contexto

A NuPtechs construiu 5 ferramentas de Code Intelligence operando isoladamente:

- **sentinel** — orquestrador hexagonal (Express, Postgres) com correlator e MCP server
- **codelens** — analisador AST/grafo (TS, ForceAtlas2)
- **nup-manifest** — analisador de auth/schema (TS + Java engine)
- **nup-probe** — captura runtime (Playwright + proxy + SDK)
- **agente QA** — markdown de prompt vivendo dentro de `easynup/.github/agents/`

Auditoria de 8 produtos concorrentes (CodeQL, Sourcegraph, Sonar, Endor, Sentry, Datadog, Snyk, knip) revelou 5 vácuos não cobertos por nenhum:

1. Permission drift declarado ↔ código ↔ role real (Identify)
2. Triple-orphan (referência declarada, sem caller, sem hit runtime)
3. Flag × AST dead-branch
4. Field-level payload death
5. Confirmador adversarial (auto-test que prova bug)

Dado isso, três modelos de organização se apresentaram:

- **Modelo A** — produto único monolítico chamado "Sentinel"
- **Modelo B** — plataforma `nup-sentinel` com módulos `nup-sentinel-{code,manifest,probe,qa,semantic}` (commercial product + OSS módulos)
- **Modelo C** — manter ferramentas separadas com identidades distintas

## Decisão

Adotar **Modelo B** com prefixo `nup-sentinel-*`:

| Hoje | Alvo | Tipo |
|---|---|---|
| `sentinel` | `nup-sentinel` | Privado (SaaS) |
| `codelens` | `nup-sentinel-code` | Público (OSS) |
| `nup-manifest` | `nup-sentinel-manifest` | Público (OSS) |
| `nup-probe` | `nup-sentinel-probe` | Público (OSS) |
| (vive em easynup) | `nup-sentinel-qa` | Público (OSS) |
| (não existe) | `nup-sentinel-semantic` | Privado (SaaS-only) |

Domínio: **`sentinel.nuptechs.com`**.

Sub-packages npm permanecem com hífen, não scope/subpath: `@nuptechs-sentinel-probe/*`, `@nuptechs-sentinel-code/*`, etc.

## Alternativas

**Modelo A (descartado):** monolito perde a tese. Os módulos resolvem problemas distintos com timing distinto (Code: pre-merge; Manifest: pre-deploy; Probe: ad-hoc; QA: confirmação). Forçar tudo num único produto destroi a clareza e o GTM.

**Modelo C (descartado):** ecossistema fragmentado, cada ferramenta peleja por mindshare individual, sem narrativa unificadora. Dificulta venda enterprise. Sem reaproveitamento de identity/billing/correlator.

## Consequências

**Positivas:**

- Produto comercial claro (`nup-sentinel`) com múltiplos pontos de entrada (módulos OSS).
- Cada módulo OSS continua independente — adopter pode usar `nup-sentinel-code` sem comprar o SaaS.
- Branding consolidado simplifica vendas e documentação.
- Lock-in suave via correlator (vácuos só fecham quando 2+ módulos emitem pro Sentinel).

**Negativas:**

- Renomeações coordenadas em 4 repos GitHub + ajustes em consumers (easynup, NuP-School).
- Lock-in da marca `nup-sentinel-*` no ecossistema NuPtechs — repos OSS divulgados como tal externamente.
- npm packages publicados no scope `@nuptechs/*` exigem renomeio versionado (`@nuptechs/sentinel`, `@nuptechs/sentinel-code`, etc.).

**Migrações pendentes:**

- Renomear repos no GitHub (ver Tarefas 0.3-0.6 do PLANO-EXECUCAO-AGENTE) — operação coordenada com checkpoint humano.
- Atualizar consumers via grep cross-repo (depende de cada projeto NuP).
- Re-publicar pacotes npm com novos nomes (depois de aprovação humana).
