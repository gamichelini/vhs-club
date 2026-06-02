# 🎬 VHS Club — a Val, atendente da locadora

Chat com a **Val**, atendente de locadora de vídeo que recomenda filmes
conferindo, ao vivo, o que está disponível nos streamings do Brasil
(Netflix, HBO Max, Prime Video, etc.). Ela pergunta seu gosto antes de
sugerir, igual atendente de locadora antiga.

O "cérebro" dela é o **Google Gemini** (free tier, sem cartão).
O catálogo vem da **TMDB** (free).

## Pré-requisitos

1. **Node.js 18+** — https://nodejs.org (recomendado: LTS).
2. **Chave da TMDB** (gratuita) — https://www.themoviedb.org → *Configurações → API* → gerar **API Key (v3 auth)**.
3. **Chave do Gemini** (gratuita) — https://aistudio.google.com → **Get API key** → **Create API key**.

## Como rodar

Abra o Terminal **na pasta do projeto** e:

```bash
npm install
npm start
```

As chaves ficam no arquivo `.env` (que já foi criado pra você).
Se quiser editar depois: abra `.env` num editor de texto e troque os valores.

Quando aparecer `🎬 VHS Club no ar!`, abra:

```
http://localhost:3000
```

Pra parar: volte no Terminal e aperte **Ctrl + C**.

## Como funciona

- O **navegador** mostra a Val e manda mensagens pro servidor.
- O **servidor** (`server.js`) conversa com a API do Gemini e expõe pra Val
  4 ferramentas que consultam a TMDB: buscar filme, achar parecidos,
  descobrir por plataforma, e checar onde assistir.
- As **chaves ficam só no servidor** (via `.env`) — nunca vão pro navegador.
- O **filtro de plataforma** (a "prateleira") faz a Val recomendar só o que
  está naquele streaming no Brasil agora.
- A Val **nunca chuta** onde um filme está — sempre via ferramentas/TMDB.

## Estrutura

```
vhs-club/
├─ server.js          ← backend (Val + Gemini + TMDB)
├─ package.json
├─ .env               ← suas chaves (NÃO comitar)
├─ .env.example       ← modelo
├─ .gitignore
├─ public/
│  └─ index.html      ← o site (a Val)
├─ test-offline.mjs   ← teste opcional sem internet (mocks)
└─ README.md
```

## Trocar o modelo

Em `server.js`, linha do `MODEL`. Free tier em 2026 oferece:
- `gemini-2.5-flash` (padrão, equilíbrio bom)
- `gemini-2.5-flash-lite` (mais barato/rápido)
- `gemini-3-flash` (mais novo)

## Dicas

- Se a Val responder estranho sobre "onde assistir", lembre que os dados
  de streaming vêm da TMDB (alimentada pelo JustWatch) e podem ter
  pequenos atrasos.
- O free tier do Gemini tem limite de ~1500 requisições/dia em modelos Flash.
- Pra uma versão pública com muita gente, vale colocar limites de uso e
  cache mais agressivo.
