# VHS Club — instruções pro Claude

Projeto próprio do Gabriel. Chat com a **Val**, atendente de locadora, que recomenda filmes
disponíveis na assinatura dos streamings do Brasil. Detalhes de produto e decisões: `VHS-CLUB-DNA.md`.

## Como o Gabriel quer a Val
- Conversa de verdade, sem cara de robô e sem interrogatório antes de entregar.
- Fluxo: **abertura** (site pergunta) → **leque** grande (tudo que encaixa, 10-20 cards em grupos)
  → **uma pergunta pra afinar** → **leque menor + veredito** ("se fosse eu, ia de X porque você falou Y").
- Card: pôster, plataforma, nota IMDb, trailer, frase da Val, selo 🔥 se estiver em alta.
- Só filmes por enquanto (séries ficam pra depois).

## Arquitetura (resumo)
- `server.js` — Express + Gemini (function calling) + TMDB + OMDb + Supabase (captura anônima de perguntas).
- Lista de fitas, notas (amei/não curti) e pedidos anteriores ficam no `localStorage` do navegador
  e vão no corpo de `/api/chat` como contexto.
- **Centro de inteligência da Val** (17/11/2026, Fase 1): toda chamada em `/api/chat` grava, em background,
  uma linha em `perguntas` no Supabase (`sessao_id` anônimo do navegador, `pedido_bruto`, `streamings`,
  `resposta_val` com texto+ids, `tema_casado` se bateu com curadoria). Falha é silenciosa — chat continua
  funcionando mesmo se o Supabase sumir. `sessaoId` é UUID por navegador gerado na primeira visita
  (`LS_SESSAO`, só pra agrupar perguntas no painel, não é login). Painel em `/admin?senha=$ADMIN_SENHA`
  (HTML inline no `server.js`, lista as últimas 200 perguntas com contadores). Projeto Supabase: `cdyzgpayvnxucxzvieja`.
  Rodapé da landing avisa que conversas são guardadas de forma anônima (LGPD mínima).
- `public/index.html` (landing) e `public/chat.html` (chat em `/chat`).
- Ferramenta principal da Val: `validar_titulos` (lote, filtra por plataforma no servidor).
- **Curadoria da casa** (13/11/2026): cada sugestão de `public/sugestoes.js` tem lista curada em `curadoria-fonte.json`
  (editável à mão). Depois de editar: `node --env-file=.env scripts/montar-curadoria.mjs` → gera `curadoria.json` (commitar).
  Frase nova em `sugestoes.js` precisa entrar em `pedidos` de algum tema, senão a Val volta a pescar de cabeça.
  75 temas (31 das sugestões + 44 categorias populares: plot twist, nacional, pra chorar, anos 80...).
  **Pedido digitado** também usa a curadoria: o script gera `curadoria-vetores.json` (Gemini embeddings, grátis,
  limite 100 frases/min — o script pausa sozinho) e o servidor compara o sentido do pedido (regra calibrada em
  `temaPorSentido`). Nesse modo a prateleira é só referência (a Val filtra pro pedido exato e o servidor não completa o leque com ela).
- Regras duras ficam no CÓDIGO, não no prompt: card só com id confirmado por ferramenta,
  filtro de plataforma/assinatura, sem card repetido, leque curto é completado pelo servidor.
- Radar 🔥 (atualiza a cada 12h em memória): TMDB Trending + "burburinho da internet" — Gemini 2.5-flash com
  busca Google pesquisa o que tá sendo comentado no BR; cada título passa pela TMDB (ano ±1, só as 5 plataformas).
  Qualidade mediana (traz muito lançamento). Gabriel NÃO quer Top 10 da Netflix (ele mesmo vê). Reddit = próximo passo (precisa app OAuth).

## Rodar e testar
```bash
npm install
npm start            # http://localhost:3000 (precisa do .env)
```
Chaves no `.env` (nunca commitar): `TMDB_KEY`, `GEMINI_KEY`, `OMDB_KEY` (opcional), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_SENHA` (pro painel `/admin`).
Sem `SUPABASE_URL`/`SECRET_KEY` o site funciona normal mas a captura fica off (warning no log). Sem `ADMIN_SENHA` o painel mostra "Admin desligado".

Pra testar a Val sem login, dá pra montar um script que extrai `conversar` + `enriquecerResposta`
do `server.js` e roda contra as APIs reais (foi assim que o prompt foi calibrado em 12/11/2026).

## Cuidados
- Prompt da Val (`systemPrompt` em `server.js`) deve continuar curto e positivo. Não voltar a
  empilhar "ERRO GRAVÍSSIMO"/"PROIBIDÃO" — isso deixou a Val robótica. Bug novo → resolver no código.
- Deploy: Render (auto-deploy do `main` no GitHub `gamichelini/vhs-club`). Esta pasta ganhou git
  local em 12/11/2026 e está ligada ao `origin` (GitHub) desde 13/11/2026.
- No Render, cadastrar `OMDB_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_SENHA` nas Environment Variables (TMDB/GEMINI já estão).
- **Isolamento entre clientes:** NUNCA reusar token/conta de outro projeto do Gabriel (ex.: Advocacia) aqui. Cada projeto tem credenciais próprias — se um esgotar cap mensal, o outro para. Pode ler código do outro projeto só pra aprender schema, mas escrever do zero no projeto atual.

## Próximos passos combinados
- **Radar via TikTok (Apify)** — aprovado, aplicar depois. Plano em `VHS-CLUB-DNA.md` ("Próximo: Radar via TikTok"). **Pendente:** Gabriel precisa criar conta Apify DEDICADA ao VHS (não reusar a da Advocacia). Volume combinado: 25 vídeos × 4 hashtags = 100/dia, ~$1.20/mês (free tier Apify cobre $5/mês, então sai de graça).
- **Fase 2 do centro de inteligência (aprendizado):** depois de uns dias com perguntas acumuladas no Supabase (~50-100), rodar script que agrupa pedidos por sentido (embeddings Gemini, já temos pipeline em `curadoria-vetores.json`), pesquisa temas novos (Gemini com busca Google, igual ao buzz), e propõe entrada nova em `curadoria-fonte.json` pra Gabriel aprovar 1-clique.
- **Latência da Val:** uns 3-8s pra responder (Render free spin-down + cascata Gemini). Possíveis melhorias futuras: cache de sessão, trocar ordem da cascata, pre-warm do dyno.
- **Publicar sempre** (autorizado pelo Gabriel em 13/11/2026): depois de cada mudança testada, `git push origin main` → Render faz o deploy. Conferir antes que nenhum `.env` entrou no git.
