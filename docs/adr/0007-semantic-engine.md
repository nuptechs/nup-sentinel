# ADR 0007 — Semantic engine (Onda 6)

**Data:** 2026-05-01
**Status:** Aceito (scaffolding) — produção pendente cota Claude/embedding
**Refs:** PLANO-EXECUCAO-AGENTE Onda 6 (renomeada de "embeddings"); MATRIZ-COMPETITIVA.md (amplificador, não vácuo de mercado)

## Contexto

A plataforma fechou os 5 vácuos de mercado nas Ondas 0–5. A Onda 6 é diferente: não cobre um vácuo (todos os 8 concorrentes têm alguma forma de busca semântica). É **amplificador** — torna os outros detectores melhores via:

1. **Dedup de findings cross-source com texto diferente.** Hoje o correlator usa `symbolRef.identifier` (string match exato). Quando dois emitters apontam o mesmo problema com identifiers ligeiramente diferentes (`User.fax` vs `users.fax`), o correlator não funde — fica falso negativo de cobertura. Embedding de `title + description` resolve.
2. **Detecção semântica de duplicação de código.** Dois pedaços de código fazendo a mesma coisa em arquivos diferentes — knip não pega (sintaxe diferente), nem CodeQL (precisa de query específica). Embedding de chunks de código com cosine similarity > 0.92 detecta.
3. **Resposta a perguntas abertas via MCP.** Cliente pergunta "onde temos lógica de cálculo de imposto?" — embedding+rerank > grep.

Onda 6 fica fora do "produto core" (5 vácuos) e entra como **camada SaaS-only** (ADR 0001 modelo B).

## Decisão

### Provedor de embeddings (D12 confirmada)

**OpenAI text-embedding-3-large.** Razões:
- Custo previsível ($0.13/1M tokens → ~$50/mês pra repos de até 200k arquivos médios).
- Dimensões: 3072 (default) ou redução opcional pra 1024/512 sem perda significativa.
- Cobertura multilíngue (português + inglês — relevante pra descrições de findings em pt-BR).
- Latência 100-400ms p50 (aceitável pra batch + cache).

Voyage Code 2 ficou descartado:
- Mais caro pra mesmo volume.
- Sem suporte oficial pt-BR.
- Marketing pesado em "código" mas benchmarks comparáveis a OpenAI nos casos reais que importam (similar findings text + code chunks).

Decisão é **revogável** via env override (`SENTINEL_EMBEDDING_PROVIDER=openai|voyage|anthropic`).

### Arquitetura

- **Pacote**: começa como subdiretório `src/services/semantic/` no `nup-sentinel`. Extrai pra repo próprio `nup-sentinel-semantic` quando houver cliente segundo (Modelo B prevê) ou volume justificar. **Sem premature extraction** — YAGNI.

- **Storage**: nova tabela `sentinel_embeddings` (migration v7) com pgvector quando habilitado, fallback array<float8> + cosine via PL/pgSQL. Postgres já é a stack — sem novo serviço.

- **Provider abstraction**: `EmbeddingPort` (port) + `OpenAIEmbeddingAdapter` (adapter). Outras implementações (Voyage, Anthropic, local Ollama) entram via mesma porta. Mantém o estilo hexagonal do resto.

- **Endpoints novos** (apikey-only, M2M):
  - `POST /api/m2m/semantic/embed` — recebe `{texts: string[]}`, retorna `{embeddings: number[][]}`. Stateless, útil pra cliente externo testar.
  - `POST /api/m2m/semantic/index/finding` — embed `title + description` de um finding, persiste em `sentinel_embeddings(finding_id, vector, model, dim)`.
  - `POST /api/m2m/semantic/dedup-findings` — pra cada par de findings com cosine > threshold, atualiza o mais recente apontando pro canônico via novo campo `mergedInto` (additivo). Não deleta.

### Cuidados

- **Cota** (D11). OpenAI tem rate limit por org. Sentinel mantém budget guard: env `SENTINEL_EMBEDDING_DAILY_BUDGET_USD` (default $10) — fail-soft (`{success:false, error:"budget_exceeded"}`) quando estourar. Métrica `sentinel_embedding_cost_usd_total{model}` no Prometheus.

- **Cache**. Embedding de texto idêntico é determinístico — cache por `sha256(text)` no DB elimina re-cobrança. TTL infinito (texto não muda; modelo é versionado por nome).

- **Privacidade**. Texto enviado pro OpenAI sai da infra do cliente. Documentar no LGPD ADR (D6 pendente). Modo offline (Ollama) entra como Adapter alternativo quando D6 fechar.

- **Versionamento de modelo**. `text-embedding-3-large` pode mudar. Cada vetor persiste `model` e `dim` — re-index quando trocar.

## Alternativas

**Embedding inline em findings (descartado):** custo de armazenamento e latência. Vetores vivem em tabela separada referenciada por `finding_id`.

**Self-hosted embedding (descartado pra fase 1):** Ollama / sentence-transformers funciona, mas qualidade inferior pra pt-BR e overhead de infra. Volta como Adapter alternativo quando custo OpenAI virar problema OU LGPD fechar exigindo on-prem.

**Vector store dedicado (descartado):** Pinecone/Weaviate/Qdrant adicionam serviço novo, custo, surface de auth. Postgres + pgvector cobre escala razoável (até ~10M vetores) sem nova dependência.

## Consequências

**Positivas:**
- Correlator passa a fundir findings que apontam o mesmo problema com texto diferente → menos ruído pro operador.
- Duplicação de código detectável sem query específica (vs CodeQL) ou parser por linguagem.
- Camada SaaS premium do produto, separada do core OSS-friendly.

**Negativas:**
- Custo recorrente OpenAI ($50–500/mês a depender de volume).
- Cliente que recusa enviar código pra terceiros (LGPD-restrito) precisa do Adapter offline → trabalho extra.
- Versionamento de modelo (text-embedding-3-large pode ser deprecado) exige re-index quando trocar.

**Próximos passos (fora deste PR de scaffolding):**
- Migration v7 `sentinel_embeddings` table.
- `EmbeddingPort` + `OpenAIEmbeddingAdapter`.
- `/api/m2m/semantic/embed` endpoint stateless (smoke test).
- `/api/m2m/semantic/dedup-findings` integrado com correlator.
- `/api/m2m/semantic/code-chunk-search` para detecção de duplicação de código (Onda 6 fase 2).
