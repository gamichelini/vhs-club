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
- `server.js` — Express + Gemini (function calling) + TMDB + OMDb. Sem login e sem banco.
- Lista de fitas, notas (amei/não curti) e pedidos anteriores ficam no `localStorage` do navegador
  e vão no corpo de `/api/chat` como contexto (Supabase removido em 12/11/2026 — o projeto tinha sumido).
- `public/index.html` (landing) e `public/chat.html` (chat em `/chat`).
- Ferramenta principal da Val: `validar_titulos` (lote, filtra por plataforma no servidor).
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
Chaves no `.env` (nunca commitar): `TMDB_KEY`, `GEMINI_KEY`, `OMDB_KEY` (opcional). As do Supabase sobraram no `.env` mas não são mais usadas.

Pra testar a Val sem login, dá pra montar um script que extrai `conversar` + `enriquecerResposta`
do `server.js` e roda contra as APIs reais (foi assim que o prompt foi calibrado em 12/11/2026).

## Cuidados
- Prompt da Val (`systemPrompt` em `server.js`) deve continuar curto e positivo. Não voltar a
  empilhar "ERRO GRAVÍSSIMO"/"PROIBIDÃO" — isso deixou a Val robótica. Bug novo → resolver no código.
- Deploy: Render (auto-deploy do `main` no GitHub `gamichelini/vhs-club`). Esta pasta ganhou git
  local em 12/11/2026 e ainda NÃO está ligada ao remoto — conferir antes de dar push.
- No Render, cadastrar `OMDB_KEY` nas Environment Variables.

## Próximos passos combinados
- **Radar via TikTok (Apify)** — aprovado, aplicar depois. Plano completo em `VHS-CLUB-DNA.md` ("Próximo: Radar via TikTok").
- Publicar no ar (GitHub → Render) quando o Gabriel disser "pode publicar".
