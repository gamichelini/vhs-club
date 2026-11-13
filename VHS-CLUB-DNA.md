# VHS Club — DNA do Produto

Documento vivo do projeto. Resumo completo do que é, como funciona, quais decisões foram tomadas e por quê.

---

## 1. O que é

Um chat de IA com a **Val**, atendente veterana de uma locadora de bairro dos anos 2000, que recomenda filmes e séries consultando **ao vivo** o catálogo dos streamings do Brasil (Netflix, HBO Max, Prime Video, Disney+, Apple TV+).

A Val não devolve listas algorítmicas: ela conversa, pergunta o gosto, dá opinião própria, e só recomenda o que realmente está disponível na plataforma escolhida.

**URL pública:** https://vhs-club.onrender.com
**Repositório:** https://github.com/gamichelini/vhs-club

---

## 2. Por que existe

- Listas de streaming são genéricas, algorítmicas, geradas por popularidade e engajamento.
- Atendentes de locadora antigas faziam algo que algoritmo não faz: liam o cliente, davam opinião, tinham gosto formado.
- A Val resgata esse atendimento humano usando IA conversacional + catálogo verificado em tempo real, sem nunca chutar onde um filme está.

---

## 3. A persona da Val

**Quem é:** atendente de balcão veterana, 15 anos no VHS Club. Perdeu o emprego pro Netflix, agora atende dentro de uma tela. Conhece o catálogo, tem opinião formada sobre cinema.

**Como fala:**
- Casual, direta, calorosa
- Português brasileiro de rua
- 2-4 linhas por mensagem na maior parte do tempo
- A persona "veterana com humor seco" aparece QUANDO O ASSUNTO É FILME; em saudações é só breve e simpática
- Vocabulário que cabe: "olha", "deixa eu te falar", "esse é uma pedrada", "filmaço", "pode confiar", "esse é meia-boca, esquece"

**Vocabulário proibido:**
- Corporativo: "certamente", "com certeza", "ótima pergunta", "claro, fico feliz em ajudar"
- Diminutivos fofinhos: "filminho", "quentinho"
- Padrões de chatbot: "que tal X?", "perfeito!", "pérola pra descrever filme"
- Hand-waving: "calma, não é sobre", "apesar de não ter", "é mais X mas Y"

---

## 4. Fluxo de atendimento (reescrito em 12/11/2026)

| Passo | O que acontece |
|---|---|
| 1. Abertura | O site pergunta: "tá a fim de que estilo de filme hoje? Ou me fala um filme que você curtiu" |
| 2. Leque | Qualquer pista já gera TUDO que encaixa (10-20 cards), em 2-4 grupos de pegadas diferentes. Sem pergunta antes. |
| 3. Afinar | Uma pergunta curta no fim do leque + até 3 chips clicáveis |
| 4. Veredito | Leque menor (4-8) na mira + "Se fosse eu, hoje ia de X — porque você falou Y" |

Só pergunta antes de entregar quando não há pista nenhuma ("oi"). Rejeitou tudo → novo leque com outro ângulo.

---

## 5. Regras invioláveis

**Filtro de prateleira:** quando o usuário escolhe uma plataforma específica, a Val SÓ recomenda títulos confirmados nela. Se o catálogo da plataforma está fraco, ela admite ("hoje a [plataforma] tá fraca pro que você quer — quer outra prateleira?").

**Regra dura de plataforma:** a Val NUNCA afirma que um título está numa plataforma sem confirmação via ferramenta no turno atual. Aceitas: `descobrir_na_plataforma`, `filmes_parecidos` com plataforma, `onde_assistir`. Sem confirmação, o título sai.

**Regra de referências:** filme citado pelo usuário como gosto NÃO entra na lista de recomendações — é apenas inspiração. Cuidado especial com títulos traduzidos (Into the Wild = Na Natureza Selvagem; Stand By Me = Conta Comigo; The Sound of Music = A Noviça Rebelde; etc.).

**Autocheck antes de enviar:** varredura literal de frases-padrão de hand-waving + varredura estrutural por "X é mais [contradição] mas [redenção]". Qualquer admissão de mismatch seguida de "mas" → título sai.

**Opinião final obrigatória:** toda recomendação termina com palpite pessoal da Val sobre qual escolher, citando a referência que o usuário deu como motivo.

---

## 6. Stack técnica (atualizado 12/11/2026)

**Backend** (`server.js`): Node 22 + Express, Gemini (function calling), TMDB, OMDb. Sem login, sem banco.

**Frontend:** `public/index.html` (landing) + `public/chat.html` (chat em `/chat`, entra direto; lista de fitas salva no navegador).
Card: pôster, plataforma, nota IMDb (fallback TMDB), trailer, frase da Val, selo 🔥. Acima de 12 cards, botão "VER MAIS".

**Modelos — cascata** (testada em 12/11/2026):
1. `gemini-3-flash-preview` — monta leque de 15+ cards e segue o fluxo
2. `gemini-3.1-flash-lite` — fallback rápido (resume; servidor completa o leque)
3. `gemini-2.5-flash-lite` — último estável
(`gemini-2.5-flash` foi descartado: inventou filme sem consultar ferramenta.)

**Ferramentas da Val:**

| Tool | O que faz |
|---|---|
| `validar_titulos(titulos[])` | PRINCIPAL. Confere até 40 títulos de uma vez, devolve só os da assinatura das plataformas marcadas (+ parecidos disponíveis se vier pouco) |
| `radar_em_alta()` | Filmes em alta agora nas plataformas da pessoa |
| `buscar_filme`, `filmes_parecidos`, `descobrir_na_plataforma`, `onde_assistir` | Ferramentas antigas, ainda disponíveis |

**Garantias no código (não no prompt):** card só sai com id confirmado por ferramenta (se a Val citar sem validar, o servidor manda ela validar); filtro de plataforma + assinatura; sem card repetido; canais "Amazon Channel" escondidos; leque com menos de 10 é completado com filmes que ela validou; grupos vazios somem.

**Radar 🔥:** atualiza a cada 12h, em memória. Fontes: (1) burburinho da internet — Gemini com busca Google pesquisa X/TikTok/Reddit/Letterboxd/sites e devolve filme + motivo; cada título é conferido na TMDB (ano ±1, só as 5 plataformas); selo "FALADO NA INTERNET" e a Val pode citar o motivo; (2) TMDB Trending dia/semana. Top 10 oficial da Netflix foi testado e descartado (o Gabriel quer burburinho, não ranking que ele mesmo vê). Reddit/Letterboxd bloqueiam acesso anônimo — Reddit exige app OAuth grátis.

**Nota IMDb:** OMDb API (free, 1.000/dia), cache de 7 dias.

**Histórico:** conversa atual vem do navegador (cards viram `[já mostrado: Título (ano) · id N]`). Pedidos anteriores (últimos 15) e a lista de fitas ficam no `localStorage` e vão como contexto de gosto.

---

## 7. Segurança e privacidade

- **Chaves de API ficam só no servidor** — nunca vão pro navegador
- `.env` local não é commitado (no `.gitignore`)
- Sem login: nada de dado pessoal no servidor; lista e histórico ficam só no navegador da pessoa
- No Render, as chaves entram via Environment Variables (criptografadas)

---

## 8. Deploy

**Local:**
```bash
cd vhs-club
npm install
# crie um .env com TMDB_KEY, GEMINI_KEY, SUPABASE_URL, SUPABASE_ANON_KEY e OMDB_KEY
npm start
# abre em http://localhost:3000
```

**Produção (Render.com, free tier):**
- Auto-deploy via `render.yaml` quando há push no branch `main` do GitHub
- Build: `npm install`
- Start: `npm start` (que internamente é `node --env-file-if-exists=.env server.js`)
- Plan: Free (750h/mês, dorme após 15min sem uso, acorda em ~30-50s)
- Domínio atual: `vhs-club.onrender.com`

---

## 9. Custos

- **TMDB:** gratuita, sem custo
- **Gemini:** free tier (~1500 req/dia em modelos Flash)
- **Render:** free tier ($0/mês, 750h grátis)
- **Domínio:** ainda não — quando definir o nome, custo de ~R$40/ano em `.com.br`

**Total atual: R$ 0/mês.**

Limite prático: se o tráfego escalar muito, o Gemini estoura a quota e a Val cai na mensagem de fallback em PT-BR. Reset diário às 21h Brasília.

---

## 10. Arquivos do projeto

```
vhs-club/
├─ server.js                  # backend (persona + Gemini + TMDB + cascata)
├─ public/
│  └─ index.html              # frontend completo (HTML+CSS+JS)
├─ package.json               # deps + script de start
├─ package-lock.json          # versão travada das deps
├─ render.yaml                # config automática do Render
├─ .env                       # chaves (LOCAL apenas, não vai pro git)
├─ .env.example               # modelo das chaves
├─ .gitignore                 # bloqueia .env e node_modules
├─ README.md                  # como rodar
└─ VHS-CLUB-DNA.md            # este documento
```

---

## 11. Histórico de decisões importantes

Lista cronológica do que foi descoberto/decidido ao longo da construção:

1. **Substituir Anthropic por Gemini** — pra evitar cobrança paga; Gemini tem free tier robusto.
2. **Cascata de 3 modelos** — `flash-preview` é mais inteligente mas mais disputado; `flash-lite` veterano é mais estável; fallback automático.
3. **Retry silencioso com backoff** — 2 tentativas por modelo; o usuário vê só o spinner de "conferindo a prateleira" mais tempo.
4. **Persona não-corporativa** — várias rodadas de refinamento pra tirar "filminho", "que tal", "pérola", "fico feliz em ajudar".
5. **Trinca de 2-3 (não força 3)** — antes a Val forçava 3 opções e inflava com matches ruins. Agora 2 honestas > 3 com hand-waving.
6. **Autocheck literal + estrutural** — pra pegar frases tipo "calma, não é sobre montanha, mas..." que ela mesma sinalizava antes de mandar.
7. **Regra dura de plataforma** — sem chamada de `onde_assistir` no turno, o título nem é mencionado. Eliminou alucinações tipo "Schindler's List na Disney+".
8. **Regra de referências traduzidas** — Val recomendou "Na Natureza Selvagem" pra alguém que citou "Into the Wild" (é o mesmo filme).
9. **Roteiro pra rejeição** — quando o usuário diz "nenhuma me agradou", a Val volta um passo em vez de soltar 4ª opção fraca.
10. **Persona flexível** — voz "veterana lived-in" aparece em assunto de filme, não em saudação simples ("e aí, tudo bem?" → resposta breve).
11. **Boas-vindas em 3 mensagens** — apresenta quem é, valida a dor ("você já rolou o catálogo 30 min"), explica o que faz.
12. **(jun/2026) Supabase** — login, histórico e watchlist (amei / não curti / já vi).
13. **(12/11/2026) Reescrita da Val** — prompt de ~540 linhas de bronca ("ERRO GRAVÍSSIMO", "PROIBIDÃO") deixava a Val robótica e cheia de perguntas antes de entregar. Virou ~110 linhas positivas com o fluxo leque → afinar → veredito. Regras duras migraram pro código.
14. **(12/11/2026) Histórico duplicado corrigido** — a Val recebia a conversa 2x (banco + navegador) e com cards em base64; causava arrastar tema antigo.
15. **(12/11/2026) Validação em lote + nota IMDb + Radar 🔥** — ver seção 6.
16. **(12/11/2026) Login removido** — Gabriel pediu pra entrar direto. O projeto Supabase já não existia (DNS não resolvia), então o login nem funcionava. Lista de fitas e memória de gosto passaram pro navegador. Contra: não sincroniza entre aparelhos.

---

## 12. Em aberto

- **Nome final** da marca e do personagem
- **Domínio próprio** quando o nome bater
- Possível adição de novas tools (busca por tema, ranking de críticos, etc.)
- Séries (decidido: depois de pilotar filmes)
- Radar com Reddit (precisa criar app OAuth grátis em reddit.com/prefs/apps; uso comercial exige rever termos)
- Ligar esta pasta ao repo do GitHub antes do próximo deploy

---

### Próximo: Radar via TikTok (aprovado pelo Gabriel em 12/11/2026, aplicar depois)

Objetivo: a Val saber o que o brasileiro tá REALMENTE comentando de filme (burburinho de gente, não ranking).

**Por que TikTok:** é onde o BR fala de filme hoje ("dica de filme", "filme que me destruiu"). Alternativas descartadas:
- X/Twitter: API paga e cara.
- Reddit: criar app exige aprovação (Responsible Builder Policy) — tentado em 12/11, bloqueado.
- Letterboxd: bloqueia robô (403).
- YouTube: pouca gente usa pra decidir filme (Gabriel vetou). Obs.: a chave do Gemini (AI Studio) NÃO funciona na YouTube API.
- Top 10 Netflix: Gabriel vetou ("isso eu abro e vejo").

**Como vai funcionar:**
1. 1x/dia o Radar roda o scraper de TikTok do **Apify** (Gabriel já usa no projeto da Advocacia) nas hashtags #dicadefilme, #filmenetflix, #filmeprime, #filmeshbomax (pegar os mais vistos da semana, ~100-200 vídeos).
2. Gemini lê as legendas e extrai quais filmes estão sendo indicados (+ o que estão falando).
3. Cada título é conferido na TMDB (ano ±1, só nas 5 plataformas) — mesma validação do buzz atual (`filmeDoBuzz` no `server.js`).
4. Selo no card: **🔥 BOMBANDO NO TIKTOK**; a Val pode dizer "esse tá rodando muito no TikTok essa semana".

**Pendências pra aplicar:**
- Token do Apify (`APIFY_TOKEN`): pedir autorização ao Gabriel pra copiar do `.env` do projeto da Advocacia (`~/Documents/MARKETING/ADVOCACIA/IA/NOVAIA`) — ou ele cola um novo.
- Calcular e mostrar o custo mensal exato do actor no Apify ANTES de ligar (estimativa: poucos dólares/mês).
- Cadastrar `APIFY_TOKEN` também no Render.

---

## 13. Filosofia

Esta linha é o resumo do projeto inteiro:

> "Antes balconista honesta que admite quando não tem, do que balconista que empurra o que tá na prateleira pra fingir que serve."

Quando a Val não tem um match perfeito, ela fala. Quando o catálogo está fraco, ela admite. Quando o usuário rejeita, ela volta um passo. A Val é honesta antes de ser útil — e por isso é útil de verdade.
