# ADR 0003 — Multi-tenancy via NuPIdentify (não duplicar)

**Data:** 2026-04-29
**Status:** Aceito
**Refs:** PLANO-EXECUCAO-AGENTE Tarefa 0.7 (revisada); memória `nup-sentinel-decisoes-2026-04-29`

## Contexto

A versão original do PLANO-EXECUCAO-AGENTE (2026-04-28) propunha que `nup-sentinel` mantivesse tabelas próprias `organizations`, `projects`, `memberships` para multi-tenancy.

Investigação subsequente do `NuPIdentify` (2026-04-29) revelou que ele **já é** um sistema multi-tenant maduro:

- Tabela `organizations` (root tenants) com hierarquia (`parentId`), plano (free/pro/enterprise), limites (`maxUsers`/`maxSystems`/`maxTeams`), features JSON, status, Stripe IDs, branding.
- Tabela `systems` (satélites do ecossistema NuP — kan, school, easynup, etc).
- 3 modelos de permissão coexistindo: RBAC (`profiles`, `userRoles`), ABAC (`policies`, `userAttributes`), ReBAC (`relationshipTuples` no estilo Zanzibar).
- Middleware `tenantResolver` com defesa cross-tenant via JWT.
- Testes `tests/security/tenant-isolation.test.ts` provando isolamento real.
- 9 migrations de schema; SCIM/SAML/OIDC; billing Stripe.

Reimplementar isso no Sentinel duplicaria meses de trabalho do Identify e introduziria divergência inevitável.

## Decisão

`nup-sentinel` é **satélite OIDC do NuPIdentify**, mesmo padrão adotado por `nup-study`, `NuP-School` e `easynup` (memória `nup-study-oidc-refactor-2026-04-27`).

| Conceito | Onde mora |
|---|---|
| Tenant / organização | `organizations` no Identify (1:1) |
| Auth | OIDC client `nup-sentinel` registrado no Identify |
| Resolução de tenant | Mesmo middleware `tenantResolver` (subdomínio + X-Tenant-ID + JWT) |
| Permissões verticais (`sentinel.findings.read`, `sentinel.config.write`, …) | `functions` do Identify, registradas como `system_id='nup-sentinel'` |
| Roles de usuário | `userRoles` do Identify com `scopeType='organization'` |
| Plan limits, billing | `organizations.plan` + `tenantSubscriptions` (Stripe) já existentes |
| Membership por projeto Sentinel | ReBAC do Identify (`relationshipTuples`) — relação `member` entre `user:<id>` e `sentinel_project:<id>` |
| **Tabela `sentinel_projects`** | **Permanece no Sentinel** — representa repos analisados, scopados por `organizationId` |
| Tabela `findings`, `probe_events` | No Sentinel, sempre com `organization_id` + `project_id` |

### Modelo de cobrança

**Bundle único** — cliente paga um plano NuPtechs e tem direito a todos os satélites incluindo Sentinel. Sem SKU separado. Quando o produto provar valor, considerar add-on no mesmo Stripe customer (extensão de schema em `tenantSubscriptions`).

### Mercado-alvo

Fase 1 — fechado: só clientes existentes da NuPtechs (que já têm `organization` no Identify).
Fase 2 — abre signup público: rota `POST /api/signup` no Identify já existe e funciona.

### Login federado

Fase 1: SAML existente no Identify (95% pronto, falta UI admin — implementada em PR separado).
Fase 2: SCIM provisioning completo + OIDC externo (Auth0/Okta como IdP do Identify).

## Alternativas

**Tabelas próprias no Sentinel (descartado):** reinventaria 9 migrations + testes de isolamento + middleware anti-spoofing + plan limits + billing Stripe. Esforço estimado: 6-10 semanas duplicando código existente, com divergência inevitável.

**`organization` no Identify + `project` como `system` no Identify (descartado):** os "sistemas" do Identify são os produtos NuPtechs satélites (nup-kan, nup-school), não os repos dos clientes do Sentinel. Inflate da tabela `systems` em ordens de magnitude.

**Estender `userRoles.scopeType` no Identify pra aceitar `"project"` (descartado pra Fase 1):** mais limpo no longo prazo mas requer mudança no Identify e propagação em RBAC resolver. Adiado — ReBAC já cobre o caso com `relationshipTuples`.

## Consequências

**Positivas:**

- Zero duplicação de tenancy / auth / billing.
- ReBAC do Identify resolve membership por projeto Sentinel sem novo schema.
- Auditoria centralizada — todo acesso a projeto Sentinel é logado no Identify.
- Plan limits do Identify já enforce escala (max users / systems / teams) — Sentinel só observa.

**Negativas:**

- Sentinel depende do Identify estar online para resolver tenant em cada request. Mitigação: cache LRU local em `getTenantBy*` (já implementado no Identify; Sentinel reusa via SDK).
- Criação de OIDC client em Identify é via rota admin (`POST /api/oidc/register`) — Sentinel precisa de admin token pra onboarding.
- Suporte a SSO externo (Auth0/Okta) só na Fase 2.

## Implicações arquiteturais

**Pré-condições já entregues no Identify (fixes de Onda 0 do plano de Identify, 2026-04-29):**

- ✅ Cross-tenant JIT defense-in-depth (PR #3 do Identify)
- ✅ Cache LRU em `getTenantBy*` (PR #4)
- ✅ Plan limits enforcement em SAML/SCIM JIT (PR #5)
- ✅ `registerClient` parity (PR #6)
- ✅ UI admin SAML por organização (PR #7)
- ✅ Wizard de onboarding com resume (PR #8)

**No Sentinel (próximas tarefas):**

- Tabela `sentinel_projects` (orgId, repoUrl, defaultBranch, etc) — esta sessão.
- IdentifyClient adapter consumindo `/api/auth/me`, `/api/permissions/check`, `/api/rebac/check` — Onda 1.
- Middleware OIDC validando token e populando `req.organizationId` — esta sessão.
