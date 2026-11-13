/**
 * VHS CLUB — A Val (versão Gemini, free tier)
 * --------------------------------------------------------------
 * Um servidor só: serve o site (public/) E conversa com a Val.
 * A Val recomenda filmes consultando o catálogo REAL do Brasil
 * pela TMDB (dados de streaming via JustWatch). As chaves ficam
 * só aqui no servidor, nunca no navegador.
 *
 * O "cérebro" da Val é o Google Gemini (free tier em 2026).
 * Como rodar: veja o README.md
 */

import express from "express";

const TMDB_KEY = process.env.TMDB_KEY;
const GEMINI_KEY = process.env.GEMINI_KEY;
const OMDB_KEY = process.env.OMDB_KEY; // opcional: nota IMDb nos cards (sem ela, usa nota TMDB)
const REGIAO = "BR";
// Cascata de modelos: tenta o melhor primeiro, cai pra alternativas em caso de overload.
// O 1º é o mais "esperto" (mais disputado), o último é o mais estável (menos sobrecarga).
// Cascata por disponibilidade observada: o flash "cheio" fica overload constante
// no horário comercial BR. O flash-lite 3.1 atende bem com o prompt novo, então
// vai primeiro pra evitar 3s desperdiçados por turno tentando o lotado.
// Testado em 12/11/2026: 3-flash-preview monta leque de 15+ cards e segue o fluxo; 3.1-flash-lite
// é bom mas resume (5-6 cards); 2.5-flash inventou filme sem consultar ferramenta (descartado).
const MODELOS = [
  "gemini-3-flash-preview",  // primário: leque grande, obedece o fluxo
  "gemini-3.1-flash-lite",   // fallback: rápido e disponível (servidor completa o leque se vier curto)
  "gemini-2.5-flash-lite",   // último estável
];
const TMDB = "https://api.themoviedb.org/3";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

if (!TMDB_KEY || !GEMINI_KEY) {
  console.error("\n⚠️  Faltam chaves no .env. Necessárias: TMDB_KEY, GEMINI_KEY (OMDB_KEY é opcional).\n");
  process.exit(1);
}

/* ---------- cache simples em memória (corta custo/latência) ---------- */
const cache = new Map();
const cacheGet = (k) => { const e = cache.get(k); if (e && e.expira > Date.now()) return e.valor; cache.delete(k); return null; };
const cacheSet = (k, v, min = 360) => cache.set(k, { valor: v, expira: Date.now() + min * 60000 });

/* ---------- helpers TMDB ---------- */
async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "pt-BR");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDB ${r.status} em ${path}`);
  return r.json();
}

let PROVIDERS = {}, GENEROS = {};
async function carregarProvedores() {
  const d = await tmdb("/watch/providers/movie", { watch_region: REGIAO });
  for (const p of d.results) PROVIDERS[p.provider_name.toLowerCase()] = p.provider_id;
}
async function carregarGeneros() {
  const d = await tmdb("/genre/movie/list");
  for (const g of d.genres) GENEROS[g.name.toLowerCase()] = g.id;
}
function idDaPlataforma(nome) {
  const apelidos = {
    "netflix": ["netflix"],
    "hbo max": ["max", "hbo max"],
    "prime video": ["amazon prime video", "prime video"],
    "disney+": ["disney plus", "disney+"],
    "apple tv+": ["apple tv plus", "apple tv+", "apple tv"],
  };
  for (const t of (apelidos[nome.toLowerCase()] || [nome.toLowerCase()]))
    if (PROVIDERS[t]) return PROVIDERS[t];
  return null;
}

// Aceita string única ("Netflix"), separada por vírgula ("Netflix, Prime Video"),
// ou array. Devolve array de provider_ids válidos.
function idsDePlataformas(input) {
  if (!input) return [];
  const lista = Array.isArray(input)
    ? input
    : String(input).split(',').map((s) => s.trim()).filter(Boolean);
  return lista.map((p) => idDaPlataforma(p)).filter(Boolean);
}
async function idsOndeAssiste(movieId) {
  const ck = `wpids:${movieId}`;
  let ids = cacheGet(ck);
  if (!ids) {
    const d = await tmdb(`/movie/${movieId}/watch/providers`);
    ids = (d.results?.[REGIAO]?.flatrate || []).map((p) => p.provider_id);
    cacheSet(ck, ids);
  }
  return ids;
}
async function ondeAssistir(movieId) {
  const ck = `wp:${movieId}`;
  const hit = cacheGet(ck);
  if (hit) return hit;
  const d = await tmdb(`/movie/${movieId}/watch/providers`);
  const br = d.results?.[REGIAO] || {};
  const out = { streaming: (br.flatrate || []).map((p) => p.provider_name), link: br.link || null, consultadoEm: Date.now() };
  cacheSet(ck, out);
  return out;
}

// Nome bonito da plataforma pro card. Canais pagos à parte ("... Amazon Channel") somem.
function nomePlataforma(n) {
  const s = String(n || "").trim();
  if (/channel/i.test(s)) return null;
  const l = s.toLowerCase();
  if (l.startsWith("netflix")) return "Netflix"; // "Netflix Standard with Ads" etc.
  if (l === "max" || l === "hbo max") return "HBO Max";
  if (l.includes("prime video")) return "Prime Video";
  if (l === "disney plus" || l === "disney+") return "Disney+";
  if (l.startsWith("apple tv")) return "Apple TV+";
  return s;
}
function limparPlataformas(nomes = []) {
  return [...new Set(nomes.map(nomePlataforma).filter(Boolean))];
}

// Streaming por assinatura (flatrate) no BR: ids + nomes numa chamada só, com cache.
async function streamingDe(movieId) {
  const ck = `stream:${movieId}`;
  const hit = cacheGet(ck);
  if (hit) return hit;
  const d = await tmdb(`/movie/${movieId}/watch/providers`);
  const flat = d.results?.[REGIAO]?.flatrate || [];
  const out = { ids: flat.map((p) => p.provider_id), nomes: flat.map((p) => p.provider_name) };
  cacheSet(ck, out);
  return out;
}

// Roda fn em cada item com no máximo `limite` ao mesmo tempo (não estoura rate limit da TMDB).
async function mapLimitado(itens, limite, fn) {
  const out = new Array(itens.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (i < itens.length) {
      const idx = i++;
      try { out[idx] = await fn(itens[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// Nota IMDb via OMDb (cache de 7 dias — free tier tem 1.000 consultas/dia).
async function notaImdb(imdbId) {
  if (!OMDB_KEY || !imdbId) return null;
  const ck = `imdb:${imdbId}`;
  const hit = cacheGet(ck);
  if (hit !== null && hit !== undefined) return hit === "-" ? null : hit;
  try {
    const r = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_KEY}`);
    const d = await r.json();
    const nota = d.Response === "True" && d.imdbRating && d.imdbRating !== "N/A" ? parseFloat(d.imdbRating) : null;
    cacheSet(ck, nota ?? "-", 7 * 24 * 60);
    return nota;
  } catch {
    return null; // falha de rede: não cacheia, tenta de novo na próxima
  }
}

// Ficha curta do filme: duração (min) e classificação indicativa no Brasil. Cache de 7 dias.
async function fichaFilme(movieId) {
  const ck = `ficha:${movieId}`;
  const hit = cacheGet(ck);
  if (hit) return hit;
  const m = await tmdb(`/movie/${movieId}`, { append_to_response: "release_dates" });
  const br = (m.release_dates?.results || []).find((r) => r.iso_3166_1 === "BR");
  const classificacao = (br?.release_dates || []).map((r) => r.certification).find(Boolean) || null;
  const out = { duracao: m.runtime || null, classificacao };
  cacheSet(ck, out, 7 * 24 * 60);
  return out;
}

/* ---------- CRITÉRIOS DA PESSOA (garantidos no código) ----------
   Duração máxima (vale pra conversa toda, o mais recente manda) e quantidade de opções (só a última msg). */
const NUMEROS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
function normalizar(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function duracaoDoTexto(t) {
  const n = normalizar(t);
  if (/(sem limite de tempo|tanto faz o tempo|pode ser longo|nao importa a duracao)/.test(n)) return 0; // 0 = remove limite
  const gatilho = /(ate|no maximo|maximo de|menos de|nao passe de|que nao passe|tenho so|so tenho|so tenho uns|tenho uns|de no maximo|curtinho de|com ate)\s+/g;
  let achado = null, m;
  while ((m = gatilho.exec(n)) !== null) {
    const resto = n.slice(m.index + m[0].length, m.index + m[0].length + 30);
    let min = null, x;
    if ((x = resto.match(/^(?:uma\s+)?hora\s+e\s+meia/))) min = 90;
    else if ((x = resto.match(/^(\d+)\s*h(?:oras?)?\s*(?:e\s*)?(\d{1,2})?\s*(?:min|m)?\b/))) min = +x[1] * 60 + (+x[2] || 0);
    else if ((x = resto.match(/^(\d{2,3})\s*(?:min|minutos)\b/))) min = +x[1];
    else if ((x = resto.match(/^(uma|duas|tres)\s+horas?(\s+e\s+meia)?/))) min = NUMEROS[x[1]] * 60 + (x[2] ? 30 : 0);
    if (min && min >= 30 && min <= 400) achado = min;
  }
  return achado;
}

function quantidadeDoTexto(t) {
  const n = normalizar(t);
  if (/\b(so|apenas|somente)\s+(um|uma|1)\b|\b(um|uma|1)\s+(filme\s+)?so\b/.test(n)) return 1;
  const x = n.match(/\b(\d{1,2}|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(opcoes|opcao|filmes|sugestoes|indicacoes|titulos|dicas|opcoes de filme)\b/);
  if (!x) return null;
  const q = /^\d+$/.test(x[1]) ? +x[1] : NUMEROS[x[1]];
  return q >= 1 && q <= 20 ? q : null;
}

function extrairCriterios(sessao) {
  let duracaoMax = null;
  const doUsuario = sessao.filter((m) => m.role === "user").map((m) => m.content);
  for (const t of doUsuario) {
    const d = duracaoDoTexto(t);
    if (d === 0) duracaoMax = null; else if (d) duracaoMax = d;
  }
  const quantidade = quantidadeDoTexto(doUsuario[doUsuario.length - 1] || "");
  return { duracaoMax, quantidade };
}

function textoCriterios(c) {
  const linhas = [];
  if (c.duracaoMax) linhas.push(`- Duração MÁXIMA: ${c.duracaoMax} minutos. Nenhum filme mais longo — o validar_titulos já corta os que passam e te diz a duração de cada um.`);
  if (c.quantidade) linhas.push(`- Quantidade pedida: EXATAMENTE ${c.quantidade} ${c.quantidade === 1 ? "filme" : "filmes"} nesta resposta (sem leque grande, sem grupos extras).`);
  return linhas.length ? `\n\n# LIMITES QUE A PESSOA DEU (mandam mais que qualquer outra instrução)\n${linhas.join("\n")}\nNunca diga que um filme "cabe no tempo" sem a duração vinda da ferramenta.` : "";
}

// Valida uma LISTA de títulos de uma vez: acha cada um na TMDB e devolve só os que estão
// na assinatura das plataformas escolhidas. É a ferramenta principal da Val pra montar o leque.
async function validarTitulos(titulos, plats = [], criterios = {}) {
  const durMax = criterios.duracaoMax || null;
  const lista = (Array.isArray(titulos) ? titulos : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 40);
  const semFiltro = !plats.length || plats.includes("Todos");
  const pidsSel = semFiltro ? null : new Set(idsDePlataformas(plats));
  await garantirRadar();

  const resultados = await mapLimitado(lista, 8, async (bruto) => {
    // Aceita "Título (2016)" pra desambiguar
    const m = bruto.match(/^(.*?)\s*\((\d{4})\)\s*$/);
    const titulo = m ? m[1] : bruto;
    const ano = m ? m[2] : null;
    const d = await tmdb("/search/movie", ano ? { query: titulo, primary_release_year: ano } : { query: titulo });
    const f = (d.results || [])[0];
    if (!f) return { pedido: bruto, status: "nao_encontrado" };
    const s = await streamingDe(f.id);
    const ok = pidsSel ? s.ids.some((id) => pidsSel.has(id)) : s.ids.length > 0;
    const base = { pedido: bruto, id: f.id, titulo: f.title, ano: (f.release_date || "").slice(0, 4) };
    if (!ok) return { ...base, status: "fora" };
    const plataformas = limparPlataformas(pidsSel ? s.nomes.filter((_, i) => pidsSel.has(s.ids[i])) : s.nomes);
    const ficha = await fichaFilme(f.id).catch(() => ({}));
    if (durMax && ficha.duracao && ficha.duracao > durMax) return { ...base, status: "longo", duracao_min: ficha.duracao };
    const alta = emAlta(f.id);
    return { ...base, status: "disponivel", duracao_min: ficha.duracao || null, plataformas, nota: f.vote_average ? Math.round(f.vote_average * 10) / 10 : null, ...(alta ? { em_alta: alta } : {}), ...(motivoAlta(f.id) ? { por_que_estao_falando: motivoAlta(f.id) } : {}) };
  });

  const disponiveis = resultados.filter((r) => r?.status === "disponivel")
    .map(({ status, pedido, ...r }) => r);
  const fora = resultados.filter((r) => r && r.status !== "disponivel" && r.status !== "longo").map((r) => r.pedido);
  const longos = resultados.filter((r) => r?.status === "longo").map((r) => `${r.titulo} (${r.duracao_min} min)`);
  const out = { disponiveis, fora_das_plataformas_ou_nao_achados: fora, ...(longos.length ? { cortados_por_passar_do_tempo: longos } : {}) };

  // Sobrou pouco? Puxa parecidos (TMDB) dos melhores achados que também estão nas plataformas.
  if (disponiveis.length < 12 && disponiveis.length > 0) {
    const vistos = new Set([...disponiveis.map((f) => f.id), ...resultados.filter(Boolean).map((r) => r.id)]);
    const recs = await Promise.all(disponiveis.slice(0, 3).map((f) => tmdb(`/movie/${f.id}/recommendations`).catch(() => ({}))));
    const cands = [];
    for (const r of recs) for (const m of (r.results || []).slice(0, 10)) {
      if (!vistos.has(m.id) && (m.vote_count || 0) >= 100) { vistos.add(m.id); cands.push(m); }
    }
    const extras = await mapLimitado(cands.slice(0, 24), 8, async (m) => {
      const s = await streamingDe(m.id);
      const ok = pidsSel ? s.ids.some((id) => pidsSel.has(id)) : s.ids.length > 0;
      if (!ok) return null;
      const ficha = await fichaFilme(m.id).catch(() => ({}));
      if (durMax && ficha.duracao && ficha.duracao > durMax) return null;
      const alta = emAlta(m.id);
      return { id: m.id, titulo: m.title, ano: (m.release_date || "").slice(0, 4), duracao_min: ficha.duracao || null, plataformas: limparPlataformas(pidsSel ? s.nomes.filter((_, i) => pidsSel.has(s.ids[i])) : s.nomes), nota: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null, ...(alta ? { em_alta: alta } : {}) };
    });
    const ext = extras.filter(Boolean).slice(0, 12);
    if (ext.length) {
      out.parecidos_disponiveis = ext;
      out.dica = "parecidos_disponiveis são parecidos com os seus achados e também estão nas plataformas. Inclua no leque os que REALMENTE encaixam no pedido (você conhece os filmes — descarte os que não têm nada a ver).";
    }
  }
  return out;
}

/* ---------- RADAR 🔥: o que tá em alta agora ----------
   Atualiza sozinho a cada 12h (na primeira consulta depois de vencer). Fonte atual: TMDB Trending
   (dia + semana). Estrutura pronta pra somar outras fontes (ex.: Reddit) no mesmo Map. */
const RADAR_VALIDADE_MS = 12 * 60 * 60 * 1000;
let radar = { atualizadoEm: 0, filmes: new Map() }; // id -> { titulo, ano, fontes: Set }
let radarCarregando = null;

// BURBURINHO DA INTERNET: o Gemini pesquisa no Google (X/Twitter, TikTok, Reddit, Letterboxd, sites de
// cinema) o que tá sendo comentado no Brasil, e cada título passa pela TMDB: só fica o que está de
// verdade em streaming por assinatura no BR. Roda em segundo plano (demora ~30s) junto com o radar.
const MODELOS_BUSCA = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
async function buzzDaInternet() {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const pedido = `Hoje é ${hoje}. Use a busca do Google pra descobrir quais FILMES (não séries) estão sendo mais comentados nas redes sociais e na internet no Brasil NESTA SEMANA (X/Twitter, TikTok, Reddit, Letterboxd, sites e canais de cinema). Só filmes que já dá pra assistir em streaming por assinatura no Brasil. Priorize o que as PESSOAS estão comentando (viralizou, final polêmico, virou meme, todo mundo recomendando) — não liste só lançamentos. No motivo, diga o que estão falando, não a data de estreia. Responda SÓ com JSON, sem markdown: [{"titulo":"título em português ou original","ano":2026,"motivo":"por que estão falando dele, máx 15 palavras"}]. Até 20 filmes.`;
  for (const modelo of MODELOS_BUSCA) {
    try {
      const r = await fetch(`${GEMINI_BASE}/${modelo}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: pedido }] }], tools: [{ google_search: {} }] }),
      });
      const d = await r.json();
      if (d.error) { console.warn(`[buzz] ${modelo}: ${d.error.code}`); continue; }
      if (!d.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length) { console.warn(`[buzz] ${modelo} não pesquisou`); continue; }
      const txt = (d.candidates[0].content?.parts || []).map((p) => p.text || "").join("");
      const lista = JSON.parse((txt.match(/\[[\s\S]*\]/) || ["[]"])[0]);
      if (Array.isArray(lista) && lista.length) return lista.slice(0, 25);
    } catch (e) {
      console.warn(`[buzz] ${modelo} falhou:`, e.message);
    }
  }
  return [];
}

// Título do buzz -> filme da TMDB que está em streaming no BR (null se não achar ou não estiver).
async function filmeDoBuzz(item) {
  const titulo = String(item?.titulo || "").trim();
  if (!titulo) return null;
  const ano = Number(item.ano) || null;
  const d = await tmdb("/search/movie", { query: titulo });
  // Ano tem que bater (±1) — evita trocar "A Odisseia (2026)" por um homônimo de 2016
  const res = (d.results || []).slice(0, 6)
    .filter((m) => !ano || Math.abs((+String(m.release_date || "").slice(0, 4) || 0) - ano) <= 1);
  // Só conta se estiver numa das 5 plataformas principais
  const principais = new Set(idsDePlataformas(["Netflix", "HBO Max", "Prime Video", "Disney+", "Apple TV+"]));
  for (const m of res.slice(0, 3)) {
    const s = await streamingDe(m.id);
    if (s.ids.some((id) => principais.has(id))) return m;
  }
  return null;
}

async function atualizarBuzz() {
  const lista = await buzzDaInternet();
  const achados = await mapLimitado(lista, 5, async (item) => ({ item, m: await filmeDoBuzz(item) }));
  let n = 0;
  for (const a of achados) {
    if (!a?.m) continue;
    const e = radar.filmes.get(a.m.id) || { id: a.m.id, titulo: a.m.title, ano: (a.m.release_date || "").slice(0, 4), fontes: new Set() };
    e.fontes.add("internet");
    e.motivo = String(a.item.motivo || "").slice(0, 160);
    radar.filmes.set(a.m.id, e);
    n++;
  }
  console.log(`[buzz] ${lista.length} filmes comentados na internet → ${n} estão em streaming no BR`);
}

async function atualizarRadar() {
  const filmes = new Map();
  const somar = (m, fonte) => {
    if (!m?.id) return;
    const e = filmes.get(m.id) || { id: m.id, titulo: m.title, ano: (m.release_date || "").slice(0, 4), fontes: new Set() };
    e.fontes.add(fonte);
    filmes.set(m.id, e);
  };
  const [dia, sem1, sem2] = await Promise.all([
    tmdb("/trending/movie/day"),
    tmdb("/trending/movie/week"),
    tmdb("/trending/movie/week", { page: 2 }),
  ]);
  (dia.results || []).forEach((m) => somar(m, "tmdb_hoje"));
  [...(sem1.results || []), ...(sem2.results || [])].forEach((m) => somar(m, "tmdb_semana"));
  radar = { atualizadoEm: Date.now(), filmes };
  console.log(`[radar] atualizado: ${filmes.size} filmes em alta`);
  // Burburinho da internet em segundo plano (não trava o servidor nem a resposta da Val)
  atualizarBuzz().catch((e) => console.warn("[buzz] falhou:", e.message));
}

async function garantirRadar() {
  if (Date.now() - radar.atualizadoEm < RADAR_VALIDADE_MS) return radar;
  if (!radarCarregando) {
    radarCarregando = atualizarRadar()
      .catch((e) => console.warn("[radar] falhou, mantendo o anterior:", e.message))
      .finally(() => { radarCarregando = null; });
  }
  await radarCarregando;
  return radar;
}

// "hoje" se tá no trending do dia; "semana" se só no da semana; null se não tá em alta.
// Rótulo do selo 🔥: comentado na internet > bombando hoje > em alta na semana. null = não tá.
function emAlta(movieId) {
  const e = radar.filmes.get(Number(movieId));
  if (!e) return null;
  if (e.fontes.has("internet")) return "internet";
  return e.fontes.has("tmdb_hoje") ? "hoje" : "semana";
}
// Por que tá em alta (só quando veio do burburinho da internet)
function motivoAlta(movieId) {
  return radar.filmes.get(Number(movieId))?.motivo || null;
}

// Ferramenta da Val: filmes em alta que estão nas plataformas da pessoa.
async function radarEmAlta(plats = []) {
  await garantirRadar();
  const semFiltro = !plats.length || plats.includes("Todos");
  const pidsSel = semFiltro ? null : new Set(idsDePlataformas(plats));
  const peso = (f) => (f.fontes.has("internet") ? 0 : f.fontes.has("tmdb_hoje") ? 1 : 2);
  const candidatos = [...radar.filmes.values()].sort((a, b) => peso(a) - peso(b));
  const res = await mapLimitado(candidatos, 8, async (f) => {
    const s = await streamingDe(f.id);
    const ok = pidsSel ? s.ids.some((id) => pidsSel.has(id)) : s.ids.length > 0;
    if (!ok) return null;
    const plataformas = limparPlataformas(pidsSel ? s.nomes.filter((_, i) => pidsSel.has(s.ids[i])) : s.nomes);
    return { id: f.id, titulo: f.titulo, ano: f.ano, plataformas, em_alta: emAlta(f.id), ...(f.motivo ? { por_que_estao_falando: f.motivo } : {}) };
  });
  return { em_alta_nas_plataformas: res.filter(Boolean) };
}

// Busca o trailer YouTube de um filme (preferência: PT-BR > Trailer EN > Teaser EN).
async function trailerYoutubeId(movieId) {
  const ck = `tr:${movieId}`;
  const hit = cacheGet(ck);
  if (hit !== null && hit !== undefined) return hit;
  try {
    const d = await tmdb(`/movie/${movieId}/videos`);
    const vids = (d.results || []).filter((v) => v.site === "YouTube");
    const trailer =
      vids.find((v) => v.type === "Trailer" && v.iso_639_1 === "pt") ||
      vids.find((v) => v.type === "Trailer") ||
      vids.find((v) => v.type === "Teaser") ||
      vids[0];
    const key = trailer?.key || null;
    cacheSet(ck, key);
    return key;
  } catch {
    cacheSet(ck, null, 60);
    return null;
  }
}

// Enriquece um filme com dados frescos da TMDB: sinopse, gênero, nota, capa, plataformas, trailer.
// Usado pelo pós-processamento de cards (em vez de confiar nos dados que a Val emite).
async function enriquecerFilme(movieId) {
  const ck = `enriq:${movieId}`;
  const hit = cacheGet(ck);
  if (hit) return hit;
  try {
    const m = await tmdb(`/movie/${movieId}`, { append_to_response: "external_ids" });
    const imdbId = m.imdb_id || m.external_ids?.imdb_id || null;
    const [wp, tr, nImdb, ficha] = await Promise.all([ondeAssistir(movieId), trailerYoutubeId(movieId), notaImdb(imdbId), fichaFilme(movieId).catch(() => ({}))]);
    const out = {
      imdbId,
      notaImdb: nImdb,   // nota IMDb (OMDb); null se não tiver chave/nota → front usa `nota` (TMDB)
      id: m.id,
      titulo: m.title,
      tituloOriginal: m.original_title || "", // ex: "Lost in Translation" pra validar quando Val usa nome em inglês
      ano: (m.release_date || "").slice(0, 4),
      nota: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
      sinopse: m.overview || "",
      genero: (m.genres || []).map((g) => g.name).join(" / "),
      capa: posterUrl(m.poster_path),
      plataformas: limparPlataformas(wp.streaming || []),
      trailer: tr,
      duracao: ficha.duracao || m.runtime || null,      // minutos
      classificacao: ficha.classificacao || null,       // ex.: "14", "L"
      linkOndeAssistir: wp.link || null,                // página TMDB/JustWatch com todos os links
      consultadoEm: wp.consultadoEm || Date.now(),      // quando a disponibilidade foi conferida
    };
    cacheSet(ck, out);
    return out;
  } catch (e) {
    console.error("enriquecerFilme", movieId, e.message);
    return null;
  }
}

// Pós-processa a resposta da Val: encontra marcadores de filme e substitui por
// cards ricos. Processa linha a linha pra capturar a opinião da Val que vem na
// linha logo após o marcador.
async function enriquecerResposta(texto, plats = [], idsPermitidos = null, validados = [], criterios = {}) {
  // 0a) Corta bordão de robô no começo da resposta ("Boa escolha.", "Ótima escolha!", "Perfeito!")
  texto = texto.replace(/^\s*(?:boa|ótima|excelente)\s+escolha[.!]*\s*|^\s*perfeito[.!]+\s*/i, "");
  // 0b) O site já apresenta a Val: corta "E aí, tudo certo? Sou a Val, do VHS Club." no começo
  texto = texto.replace(/^\s*(?:(?:e a[íi]|oi|ol[áa]|opa)[^.!?\n]{0,40}[.!?]\s*)?(?:(?:aqui (?:[ée] )?a|sou a) val[^.!?\n]{0,60}[.!?]\s*)/i, "");
  // 0) Remove auto-flagelo e "vamos zerar" no início da resposta — herança de sessões antigas
  let txt = texto.replace(
    /^[ \t]*(?:e a[íi]!?\s*)?(?:como\s+a\s+gente\s+deu\s+umas?\s+voltas?\s+errad[ao]s?[^.]*\.|vamos zerar[^.]*\.|esquece o que passou\.|olha[, ]+sinto muito[^.]*\.|vamos corrigir[^.]*\.|vacilo meu[, ]+desculpa\.|tem raz[ãa]o[, ]+vacilei[^.]*\.)\s*/i,
    ""
  );
  // 0.5) Filtra chips que mudam o tema (ex: "outro esporte" quando pediu futebol).
  //      Detecta padrões "outr[oa]s? [esportes|modalidade|tema]" ou "que n[ãa]o seja [tema]"
  //      e remove apenas essas chips, mantendo as outras.
  txt = txt.replace(/\[SUGEST[ÕO]ES:([^\]]+)\]/g, (orig, sugTxt) => {
    const opcoes = sugTxt.split("|").map((s) => s.trim()).filter(Boolean);
    const proibido = /outr[oa]s?\s+(esportes?|modalidade|tema|categoria)|outr[oa]\s+coisa|pular\s+pra\s+outr[oa]|mudar\s+de\s+tema/i;
    const limpas = opcoes.filter((opt) => !proibido.test(opt));
    if (!limpas.length) return ""; // todas eram inválidas, sumir
    if (limpas.length === opcoes.length) return orig; // nada removido
    return `[SUGESTÕES:${limpas.join("|")}]`;
  });
  // 1) Remove qualquer marcador VHSCARD INCOMPLETO (resposta truncada da Val)
  txt = txt.replace(/\[\[VHSCARD:[^\[\]]*$/g, "").replace(/\[FILME:[^\]]*$/g, "");

  const linhas = txt.split("\n");
  // Formato preferido: [FILME:id|Título Real|opinião] (3 campos, valida título)
  // Formato com 2 campos: [FILME:id|opinião] (backward compat, sem validação)
  // Formato sem opinião: [FILME:id] (backward compat, opinião vem da linha seguinte)
  // Aceita tudo na mesma regex; campos extras são parseados manualmente
  const reMarkerInline = /\[FILME:(\d+)((?:\|[^\]]*)*)\]/g;
  const reMarkerAntigoG = /!\[([^\]|]+)\|(\d+)\|([^\]|]*)\|([^\]]*)\]\((https?:[^)]+)\)/g;

  // Coleta IDs (qualquer ocorrência em qualquer linha, mesmo inline)
  const ids = new Set();
  for (const ln of linhas) {
    let m;
    while ((m = reMarkerInline.exec(ln)) !== null) ids.add(parseInt(m[1]));
    while ((m = reMarkerAntigoG.exec(ln)) !== null) ids.add(parseInt(m[2]));
  }
  if (!ids.size) return txt;

  // Filtro de plataforma
  const semFiltro = !plats.length || plats.includes("Todos");
  const idsSelecionados = semFiltro ? null : new Set(idsDePlataformas(plats));

  // Enriquece em paralelo
  const dados = {};
  await Promise.all([...ids].map(async (id) => { dados[id] = await enriquecerFilme(id); }));

  // Normaliza título pra comparação (lowercase, sem acentos, sem artigos, só alfa-num)
  function normalizarTitulo(t) {
    return String(t || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/^(the|o|a|os|as|um|uma|uns|umas|el|la|le|les)\s+/i, "")
      .replace(/[^a-z0-9]/g, "");
  }

  // Detecta hand-waving/mismatch admissão na opinião da Val.
  // SÓ pega admissões explícitas de mismatch ("não é sobre X mas vou recomendar mesmo assim").
  // Frases comuns que usam "apesar de" / "embora" NÃO são hand-waving — são qualificadores legítimos.
  function temHandWaving(texto) {
    if (!texto) return false;
    const padroes = [
      /n[ãa]o é sobre [^.]*tradicionai/i,
      /n[ãa]o é exatamente [^.]+mas/i,
      /n[ãa]o é um filme de [^.]*mas/i,
      /fog[ea]m? do lugar.?comum/i,
      /calma[, ]+n[ãa]o é/i,
      /n[ãa]o tem .* como cen[áa]rio central/i,
      /sei que parece [^.]+mas/i,
      /fugindo (um pouco )?do que/i,
    ];
    return padroes.some((re) => re.test(texto));
  }

  // Helper: monta marcador final pro frontend (ou null se inválido)
  // tituloDeclarado: o título que a Val escreveu no marcador (campo 2)
  const jaEmitidos = new Set();
  const removidosPorCriterio = []; // títulos tirados por duração/quantidade (pra limpar o texto que cita eles)
  function marcadorPara(id, valDiz, tituloDeclarado = "") {
    if (jaEmitidos.has(id)) return null; // mesmo filme 2x na resposta
    const dd = dados[id];
    if (criterios.duracaoMax && dd?.duracao && dd.duracao > criterios.duracaoMax) {
      console.warn(`[criterio] ${dd.titulo} tem ${dd.duracao} min > ${criterios.duracaoMax}, removido`);
      removidosPorCriterio.push(dd.titulo, tituloDeclarado);
      return null;
    }
    if (criterios.quantidade && jaEmitidos.size >= criterios.quantidade) {
      removidosPorCriterio.push(dd?.titulo, tituloDeclarado);
      return null;
    }
    if (idsPermitidos && !idsPermitidos.has(id)) {
      console.warn(`[filtro] Filme ${id} "${tituloDeclarado}" sem confirmação de ferramenta, removido`);
      return null;
    }
    const d = dados[id];
    if (!d || !d.capa || !d.plataformas?.length) {
      console.warn(`[filtro] Filme ${id} sem capa/streaming, removido`);
      return null;
    }
    if (idsSelecionados) {
      const idsFilme = d.plataformas.map((p) => idDaPlataforma(p)).filter(Boolean);
      const intersecao = idsFilme.some((idF) => idsSelecionados.has(idF));
      if (!intersecao) {
        console.warn(`[filtro] Filme ${id} "${d.titulo}" fora do filtro (tá em: ${d.plataformas.join(", ")}), removido`);
        return null;
      }
    }
    // VALIDAÇÃO DE TÍTULO: agora é SOFT — se Val errar leve, sobrescreve com o título real do TMDB.
    // O card sempre exibe o título do TMDB (vem de `d.titulo`), então erro de digitação da Val não
    // chega no usuário. Só fazemos log pra rastrear.
    if (tituloDeclarado) {
      const tDecl = normalizarTitulo(tituloDeclarado);
      const tPt = normalizarTitulo(d.titulo);
      const tOrig = normalizarTitulo(d.tituloOriginal);
      const similar = (a, b) => {
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.length >= 4 && b.includes(a)) return true;
        if (b.length >= 4 && a.includes(b)) return true;
        return false;
      };
      const bate = similar(tDecl, tPt) || similar(tDecl, tOrig);
      if (!bate) {
        console.warn(`[soft-filter] Filme ${id}: Val escreveu "${tituloDeclarado}" mas TMDB tem "${d.titulo}". Card mostrado com título correto da TMDB.`);
        // NÃO descarta — apenas loga. O card será renderizado com d.titulo (correto).
      }
    }
    // Hand-waving: SÓ descarta se for muito explícito ("não é exatamente X mas vou recomendar")
    if (valDiz && temHandWaving(valDiz)) {
      console.warn(`[filtro] Filme ${id} "${d.titulo}" — VAL DIZ tem hand-waving ("${valDiz.slice(0, 60)}..."), removido`);
      return null;
    }
    // emAlta calculado na hora (não vai no cache do filme, que dura 6h)
    jaEmitidos.add(id);
    const PRINCIPAIS = ["Netflix", "HBO Max", "Prime Video", "Disney+", "Apple TV+"];
    const principais = d.plataformas.filter((p) => PRINCIPAIS.includes(p));
    const platsCard = idsSelecionados
      ? d.plataformas.filter((p) => idsSelecionados.has(idDaPlataforma(p)))
      : (principais.length ? principais : d.plataformas);
    const payload = { ...d, plataformas: platsCard, valDiz: valDiz || null, emAlta: emAlta(id) };
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return `[[VHSCARD:${b64}]]`;
  }

  // Processa linha a linha. Marcadores na linha são substituídos in-place.
  // A linha imediatamente seguinte (se for texto simples) é capturada como opinião
  // e atribuída ao ÚLTIMO marcador da linha atual.
  const out = [];
  const linhasConsumidas = new Set();

  for (let i = 0; i < linhas.length; i++) {
    if (linhasConsumidas.has(i)) continue;
    let ln = linhas[i];
    // Parse a linha pra extrair marcadores [FILME:id|...] com 1, 2 ou 3 campos
    const marcadoresNaLinha = [];
    let m;
    reMarkerInline.lastIndex = 0;
    while ((m = reMarkerInline.exec(ln)) !== null) {
      const id = parseInt(m[1]);
      const extras = (m[2] || "").split("|").slice(1).map((s) => s.trim()); // pula o ID
      // Formato 3 campos: [id, título, opinião]
      // Formato 2 campos: [id, opinião] (sem título)
      // Formato 1 campo: [id] (opinião via linha seguinte)
      let titulo = "";
      let opinion = "";
      if (extras.length >= 2) { titulo = extras[0]; opinion = extras.slice(1).join("|"); }
      else if (extras.length === 1) { opinion = extras[0]; }
      marcadoresNaLinha.push({ id, titulo, opinion, tipo: "novo" });
    }
    reMarkerAntigoG.lastIndex = 0;
    while ((m = reMarkerAntigoG.exec(ln)) !== null) {
      marcadoresNaLinha.push({ id: parseInt(m[2]), titulo: m[1].trim(), opinion: "", tipo: "antigo" });
    }

    if (!marcadoresNaLinha.length) { out.push(ln); continue; }

    // BACKWARD COMPAT: se NENHUM marcador da linha tem opinião embutida,
    // tenta capturar a próxima linha não-vazia como opinião do último marcador
    const algumTemOpiniao = marcadoresNaLinha.some((mk) => mk.opinion);
    let valDizFallback = "";
    if (!algumTemOpiniao) {
      let j = i + 1;
      while (j < linhas.length && !linhas[j].trim()) j++;
      if (j < linhas.length) {
        const prox = linhas[j];
        const ehMarcador = /\[FILME:\d+/.test(prox) || /!\[[^\]|]+\|\d+\|/.test(prox);
        if (!ehMarcador && prox.length < 300) {
          valDizFallback = prox.trim();
          linhasConsumidas.add(j);
        }
      }
    }

    // Substitui cada marcador na linha
    let contadorNovo = 0;
    ln = ln.replace(/\[FILME:(\d+)((?:\|[^\]]*)*)\]/g, () => {
      const mk = marcadoresNaLinha[contadorNovo++];
      const opin = mk.opinion || (contadorNovo === marcadoresNaLinha.length ? valDizFallback : "");
      return marcadorPara(mk.id, opin, mk.titulo) || "";
    });
    let contadorAntigo = 0;
    ln = ln.replace(/!\[([^\]|]+)\|(\d+)\|([^\]|]*)\|([^\]]*)\]\((https?:[^)]+)\)/g, (_match, tit, idStr) => {
      contadorAntigo++;
      const id = parseInt(idStr);
      const opin = !algumTemOpiniao && contadorAntigo === marcadoresNaLinha.length ? valDizFallback : "";
      return marcadorPara(id, opin, tit) || "";
    });

    out.push(ln);
  }

  // LEQUE CURTO? Se a Val validou mais filmes do que mostrou (e não é a rodada do veredito),
  // completa com os que ela mesma escolheu e validou, logo depois do último card.
  const ehVeredito = /se fosse eu/i.test(txt) || !!criterios.quantidade;
  const emitidos = out.filter((l) => l.includes("[[VHSCARD:")).length;
  if (!ehVeredito && emitidos > 0 && emitidos < 10 && validados.length) {
    const sobra = [];
    const vistosAqui = new Set();
    for (const f of validados) {
      if (sobra.length >= 15 - emitidos) break;
      if (jaEmitidos.has(f.id) || vistosAqui.has(f.id)) continue;
      vistosAqui.add(f.id);
      if (!dados[f.id]) dados[f.id] = await enriquecerFilme(f.id);
      const mk = marcadorPara(f.id, "", f.titulo);
      if (mk) sobra.push(mk);
    }
    if (sobra.length) {
      let ultimo = -1;
      out.forEach((l, i) => { if (l.includes("[[VHSCARD:")) ultimo = i; });
      out.splice(ultimo + 1, 0, "", "**Mais na prateleira nessa pegada**", "", ...sobra.flatMap((c) => [c, ""]));
    }
  }
  // Texto que cita filme removido por critério (ex.: veredito "ia de **Glass Onion**") sai junto
  let final = out;
  const tirados = removidosPorCriterio.filter(Boolean).map((t) => normalizar(t)).filter((t) => t.length >= 3);
  if (tirados.length) {
    final = out.filter((l) => l.includes("[[VHSCARD:") || !tirados.some((t) => normalizar(l).includes(t)));
  }
  return limparGruposVazios(final.join("\n"));
}

// Se todos os cards de um grupo foram filtrados, o título **do grupo** some junto.
function limparGruposVazios(txt) {
  const linhas = txt.split("\n");
  const ehTitulo = (l) => /^\s*\*\*[^*]+\*\*\s*$/.test(l);
  const res = [];
  for (let i = 0; i < linhas.length; i++) {
    if (ehTitulo(linhas[i])) {
      let j = i + 1;
      while (j < linhas.length && !linhas[j].trim()) j++;
      if (j >= linhas.length || !linhas[j].includes("[[VHSCARD:")) continue; // grupo vazio
    }
    res.push(linhas[i]);
  }
  return res.join("\n").replace(/\n{3,}/g, "\n\n");
}

/* ---------- ferramentas da Val (formato Gemini: functionDeclarations) ---------- */
const tools = [
  { name: "validar_titulos", description: "FERRAMENTA PRINCIPAL. Recebe uma lista de títulos de filmes (até 40; use 'Título (ano)' pra desambiguar) e devolve, numa chamada só, quais estão disponíveis na assinatura das plataformas da pessoa agora — com id, título oficial, ano, plataformas e nota.",
    parameters: { type: "object", properties: { titulos: { type: "array", items: { type: "string" } }, duracao_max_min: { type: "integer", description: "Duração máxima em minutos, se a pessoa deu limite de tempo." } }, required: ["titulos"] } },
  { name: "radar_em_alta", description: "Filmes em alta AGORA e disponíveis nas plataformas da pessoa: os mais comentados na internet no Brasil (redes sociais, Reddit, Letterboxd, sites de cinema — vem com por_que_estao_falando) e os mais buscados do dia/semana. Use quando ela pedir 'o que tá bombando', 'lançamento', 'o que todo mundo tá vendo', ou pra temperar um leque com algo do momento.",
    parameters: { type: "object", properties: {} } },
  { name: "buscar_filme", description: "Acha o ID de um filme pelo título (ex.: 'Conta Comigo').",
    parameters: { type: "object", properties: { titulo: { type: "string" } }, required: ["titulo"] } },
  { name: "filmes_parecidos", description: "Filmes parecidos a partir de um ID. Se 'plataforma' vier, retorna só os disponíveis nela no Brasil agora. Pra múltiplas plataformas, separe por vírgula: 'Netflix, Prime Video'.",
    parameters: { type: "object", properties: { movie_id: { type: "integer" }, plataforma: { type: "string" } }, required: ["movie_id"] } },
  { name: "descobrir_na_plataforma", description: "Filmes populares numa plataforma no Brasil agora; gênero opcional. Pra múltiplas plataformas, separe por vírgula: 'Netflix, Prime Video' — retorna filmes que estão em qualquer uma delas.",
    parameters: { type: "object", properties: { plataforma: { type: "string" }, genero: { type: "string" } }, required: ["plataforma"] } },
  { name: "onde_assistir", description: "Em quais streamings (assinatura) um filme está no Brasil agora.",
    parameters: { type: "object", properties: { movie_id: { type: "integer" } }, required: ["movie_id"] } },
];

// Monta URL pública da capa do filme na TMDB (tamanho w300 ≈ 300px, leve e nítido).
function posterUrl(path) { return path ? `https://image.tmdb.org/t/p/w300${path}` : null; }

async function executarTool(nome, input, plats = [], criterios = {}) {
  if (nome === "validar_titulos") {
    // Limite de tempo: vale o mais restritivo entre o que a Val passou e o que a pessoa disse
    const lims = [criterios.duracaoMax, input.duracao_max_min].filter((x) => Number(x) > 0).map(Number);
    return await validarTitulos(input.titulos, plats, { duracaoMax: lims.length ? Math.min(...lims) : null });
  }
  if (nome === "radar_em_alta") return await radarEmAlta(plats);
  if (nome === "buscar_filme") {
    const d = await tmdb("/search/movie", { query: input.titulo });
    return (d.results || []).slice(0, 5).map((m) => ({ id: m.id, titulo: m.title, ano: (m.release_date || "").slice(0, 4), sinopse: m.overview, capa: posterUrl(m.poster_path) }));
  }
  if (nome === "filmes_parecidos") {
    const d = await tmdb(`/movie/${input.movie_id}/recommendations`);
    let lista = (d.results || []).slice(0, 12);
    if (input.plataforma) {
      const pids = idsDePlataformas(input.plataforma);
      const out = [];
      if (pids.length) {
        for (const m of lista) {
          const idsFilme = await idsOndeAssiste(m.id);
          if (pids.some((p) => idsFilme.includes(p))) out.push(m);
          if (out.length >= 6) break;
        }
        lista = out;
      }
    }
    return lista.slice(0, 6).map((m) => ({ id: m.id, titulo: m.title, ano: (m.release_date || "").slice(0, 4), capa: posterUrl(m.poster_path) }));
  }
  if (nome === "descobrir_na_plataforma") {
    const pids = idsDePlataformas(input.plataforma);
    if (!pids.length) return { erro: `Plataforma(s) "${input.plataforma}" não encontrada(s) no BR.` };
    const params = {
      with_watch_providers: pids.join("|"), // "|" = OR no TMDB (qualquer uma das plataformas)
      watch_region: REGIAO,
      with_watch_monetization_types: "flatrate",
      sort_by: "popularity.desc",
      "vote_count.gte": 200,    // corta lixo obscuro (filme com 3 votos)
      "vote_average.gte": 6.0,  // filtro de qualidade mínima (TMDB usa 0-10; ~IMDB 6.0 = decente)
    };
    if (input.genero && GENEROS[input.genero.toLowerCase()]) params.with_genres = GENEROS[input.genero.toLowerCase()];
    let d = await tmdb("/discover/movie", params);
    // Fallback: se o filtro estrito devolver muito pouco (<4), afrouxa pra não deixar Val na mão
    if (!d.results || d.results.length < 4) {
      const paramsRelax = { ...params, "vote_count.gte": 50, "vote_average.gte": 5.5 };
      d = await tmdb("/discover/movie", paramsRelax);
    }
    return (d.results || []).slice(0, 10).map((m) => ({ id: m.id, titulo: m.title, ano: (m.release_date || "").slice(0, 4), nota: m.vote_average, capa: posterUrl(m.poster_path) }));
  }
  if (nome === "onde_assistir") return await ondeAssistir(input.movie_id);
  return { erro: "ferramenta desconhecida" };
}

/* ---------- persona + loop de agente ---------- */
function systemPrompt(plataformas) {
  const plats = Array.isArray(plataformas) ? plataformas : (plataformas ? [plataformas] : []);
  const semFiltro = plats.length === 0 || plats.includes("Todos");
  const lista = plats.length === 2 ? plats.join(" e ") : plats.length > 2 ? plats.slice(0, -1).join(", ") + " e " + plats[plats.length - 1] : plats[0];
  const prateleira = semFiltro
    ? "A pessoa aceita qualquer streaming (Netflix, HBO Max, Prime Video, Disney+, Apple TV+)."
    : `A pessoa marcou: ${lista}. As ferramentas já filtram por essas plataformas — só existe pra você o que elas devolverem.`;

  return `Você é a Val, atendente do VHS Club — a locadora de bairro que virou chat. Passou anos atrás do balcão, viu de tudo, tem gosto formado e adora acertar o filme que a pessoa vai ver agora. Fala como gente: português brasileiro, informal, caloroso, com opinião. Não é assistente virtual e não age como uma.

# PRATELEIRA
${prateleira}
Só existe filme que está NA ASSINATURA dessas plataformas agora (aluguel/compra não conta). Quem confirma isso são as ferramentas, não a sua memória.

# COMO É O ATENDIMENTO

O site já abriu a conversa por você (se apresentou e perguntou o que a pessoa tá a fim). Então NÃO se apresente de novo e não comece com "oi": vai direto ao ponto. Daí pra frente:

**1. LEQUE — a primeira resposta a qualquer pista já é uma prateleira cheia.**
Qualquer pista basta: um gênero ("comédia"), um clima ("tô cansado"), um filme de referência ("tipo Interestelar"), um recorte ("anos 80"). NÃO faça pergunta antes de entregar. Entregue TUDO o que encaixa minimamente: se as ferramentas devolveram 16 filmes que servem, mostre os 16. Leque de 5 ou 6 é pouco — o normal é 10 a 20, organizados em 2 a 4 grupos com pegadas diferentes, cada grupo com um título curto em negrito. Ordene do encaixe mais forte pro mais solto.
Depois do leque, UMA pergunta curta pra afinar ("qual desses grupos te puxou?", "quer mais curto ou pode ser épico de 3h?", "sozinho ou com alguém?").

**2. AFINAR — com a resposta, você estreita.**
Manda um leque menor (4 a 8) bem na mira do que ela disse e fecha com o VEREDITO. Pode reaproveitar filmes já validados nesta conversa; qualquer filme NOVO passa por validar_titulos antes.

**3. VEREDITO — o seu palpite, sempre que você estreitou.**
Uma ou duas frases: "Se fosse eu, hoje ia de **X** — porque você falou que queria Y." Cite o que a pessoa disse. É aqui que você mostra que entende de cinema.

**LIMITES DA PESSOA MANDAM MAIS QUE O LEQUE.** Se ela pediu um número ("me indica 3", "só um"), entregue exatamente esse número. Se deu limite de tempo ("até 2h", "tenho 90 minutos"), passe duracao_max_min no validar_titulos e nunca indique filme mais longo. Use a duracao_min que a ferramenta devolve; não chute duração.

Daí a conversa segue livre: ela pode pedir mais, mudar de ideia, perguntar de um filme. Se ela rejeitar tudo, não interrogue: mande outro leque com um ângulo diferente e pergunte de passagem o que não bateu.
Só pergunte ANTES de entregar se não houver pista nenhuma ("oi", "tudo bem?") — aí responde simpática e curta (1-2 linhas), puxando uma direção, SEM chamar ferramenta.
Pergunta direta sobre um filme ("vale a pena Duna?", "quem dirigiu Drive?") → responde com opinião, em poucas linhas. Card só se fizer sentido.

# COMO MONTAR O LEQUE (ferramentas, sempre em silêncio)

Todo card precisa de um id que veio de ferramenta NESTA conversa. Sem isso, o filme não aparece pra pessoa.

1. Pense você mesma em 25 a 35 filmes que encaixam, cobrindo ângulos variados do pedido (clássicos, recentes, nacionais, menos óbvios). Use seu repertório de cinéfila — não dependa de lista de popularidade.
2. Chame **validar_titulos** UMA vez com a lista inteira (use "Título (ano)" quando houver risco de confusão). Ela devolve quais estão nas plataformas, com id, título oficial, ano e nota — e às vezes também parecidos_disponiveis: aproveite os que encaixam.
3. Se sobraram poucos (menos de 8), chame validar_titulos de novo com outros 20 candidatos. Pode usar filmes_parecidos(id) a partir de uma boa referência pra achar mais.
4. Pedido de "lançamento", "o que tá bombando", "o que todo mundo tá vendo" → use **radar_em_alta**. Num leque comum, se algum filme vier com em_alta, comente com naturalidade — se vier por_que_estao_falando, use isso (ex.: "esse viralizou no TikTok essa semana por causa do final").
Nunca narre o processo ("deixa eu ver", "consultei"). Você simplesmente sabe o que tem na prateleira.

# FORMATO DO CARD
Cada filme vira um card (pôster, nota IMDb, plataforma, trailer) a partir deste marcador, sozinho na linha:

[FILME:id|Título oficial|uma frase sua sobre ESSE filme]

- id e título exatamente como vieram da ferramenta. Nunca invente id.
- A frase é sobre o filme daquele id: a experiência de assistir, não o gênero. "Daqueles que você termina e fica olhando pro teto" > "é um drama".
- Varie as frases. Nada de começar todas igual.

Exemplo de leque (pedido: "algo com ET"):

Pesquei bastante coisa boa nessa:

**Contato que mexe com a cabeça**

[FILME:329865|A Chegada|Você sai dele repensando como fala com as pessoas. Sério.]

[FILME:157336|Interestelar|Três horas que passam voando — e um final que divide amizades.]

**Invasão com pipoca**

[FILME:74|Guerra dos Mundos|Spielberg botando o Tom Cruise pra correr do começo ao fim.]

**ET com segunda camada**

[FILME:17654|Distrito 9|Começa como documentário e vira uma porrada sobre preconceito.]

Bateu em algum desses grupos ou quer que eu puxe pra outro lado?

[SUGESTÕES:Mais pro lado do suspense|Algo leve pra ver em família|Fala mais do Distrito 9]

# CHIPS
Ao fim de um leque, ofereça até 3 atalhos no formato [SUGESTÕES:a|b|c], escritos como se fosse a pessoa falando. Cada um puxa numa direção diferente, dentro do tema dela. Não mude o tema que ela pediu.

# BOM SENSO DE BALCONISTA
- Filme que a pessoa citou como referência não entra na lista — nem com o título traduzido (Into the Wild = Na Natureza Selvagem, Stand By Me = Conta Comigo).
- Respeite o contexto dela abaixo: não recomende o que ela já viu ou não curtiu; use o que ela amou como bússola.
- Cada mensagem dela é o pedido de agora. Não arraste tema de conversa antiga se ela não pediu.
- Se a prateleira tá fraca pro pedido, fala com naturalidade e sugere afrouxar algo ou marcar outra plataforma. Nunca force filme que não tem nada a ver.
- Errou? "Foi mal" e entrega o certo. Sem textão, sem culpar ninguém.
- Se perguntarem: "sou a Val, atendente aqui do VHS Club".

# SUA VOZ
Natural, direta, com graça. Frases curtas. Pode usar "olha", "esse é filmaço", "pode ir sem medo", "esse é pra quem tem estômago" — quando sair natural, nunca como bordão.
Evite cara de robô: "certamente", "com certeza!", "ótima escolha", "boa escolha", "fico feliz em ajudar", "no que posso te ajudar", "que tal...?", "perfeito!", diminutivos tipo "filminho". Não repita as mesmas frases de abertura entre respostas.`;
}


// Detecta overload/rate-limit do Gemini (free tier vive sobrecarregado em horário de pico)
function ehSobrecarga(err) {
  if (!err) return false;
  const s = JSON.stringify(err).toLowerCase();
  return /unavailable|resource_exhausted|overload|high demand|rate.?limit|quota|429|503/.test(s);
}

// Espera N ms (Promise-based sleep)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(body) {
  const tentativasPorModelo = 2;
  let ultimoErro = null;
  // Cascata: pra cada modelo, tenta N vezes; se persistir overload, vai pro próximo modelo.
  for (let m = 0; m < MODELOS.length; m++) {
    const modelo = MODELOS[m];
    const url = `${GEMINI_BASE}/${modelo}:generateContent`;
    for (let i = 0; i < tentativasPorModelo; i++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (data.error && ehSobrecarga(data.error)) {
          ultimoErro = data.error;
          const espera = 600 * Math.pow(2, i); // 0.6s, 1.2s por modelo
          console.warn(`${modelo} sobrecarregado (tentativa ${i + 1}/${tentativasPorModelo}). Esperando ${espera}ms.`);
          await dormir(espera);
          continue;
        }
        if (data.error) {
          // erro NÃO-overload (404, safety, payload muito grande): loga e tenta próximo modelo
          console.warn(`${modelo} retornou erro não-overload: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
          ultimoErro = data.error;
          break; // sai do retry deste modelo, vai pro próximo
        }
        if (m > 0) console.log(`Resposta veio do modelo de fallback: ${modelo}`);
        return data;
      } catch (e) {
        ultimoErro = { message: String(e.message || e) };
        await dormir(600 * Math.pow(2, i));
      }
    }
    console.warn(`${modelo} esgotou tentativas. ${m < MODELOS.length - 1 ? "Tentando próximo modelo." : "Sem mais modelos."}`);
  }
  return { error: ultimoErro || { message: "todos os modelos sobrecarregados" } };
}

// Garante que o functionResponse.response do Gemini seja um objeto (não array nem primitivo).
function wrapResult(out) {
  if (out && typeof out === "object" && !Array.isArray(out)) return out;
  return { result: out };
}

async function conversar(messages, plataforma, contextoUsuario = "", criterios = {}) {
  // Converte [{role:"user|assistant", content:"texto"}] -> contents do Gemini
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }],
  }));

  // Anexa contexto do usuário ao system prompt (histórico, watchlist, vistos)
  const systemTxt = (contextoUsuario
    ? `${systemPrompt(plataforma)}\n\n# CONTEXTO DESTE USUÁRIO (informação invisível, NÃO mencione expressamente)\n${contextoUsuario}`
    : systemPrompt(plataforma)) + textoCriterios(criterios);

  const body = {
    systemInstruction: { parts: [{ text: systemTxt }] },
    tools: [{ functionDeclarations: tools }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0.9 },
  };

  // IDs que a Val pode usar em card: os que vieram de ferramenta neste turno
  // + os já mostrados nesta conversa (cardsParaTexto deixa "id N" no histórico).
  const idsConfirmados = new Set();
  const validados = []; // filmes que validar_titulos confirmou neste turno (pra completar leque curto)
  for (const m of messages) for (const x of String(m.content ?? "").matchAll(/id (\d+)\]/g)) idsConfirmados.add(Number(x[1]));
  let jaCobrou = false;
  let jaCobrouVazio = false;

  // validar_titulos resolve em lote, então poucas rodadas bastam
  for (let i = 0; i < 10; i++) {
    const resp = await gemini({ ...body, contents });

    if (resp.error) {
      console.error("Gemini error:", JSON.stringify(resp.error));
      if (ehSobrecarga(resp.error)) {
        return { texto: "Ô, tá uma fila danada aqui no balcão hoje — o sistema engasgou. Me chama de novo em uns 30 segundos que eu te atendo direito.", idsConfirmados: new Set() };
      }
      return { texto: "Deu um ruído na fita aqui — algo travou do meu lado. Pergunta de novo?", idsConfirmados: new Set() };
    }

    const cand = resp.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const fnCalls = parts.filter((p) => p.functionCall);

    if (fnCalls.length > 0) {
      contents.push({ role: "model", parts });
      // Executa todas as ferramentas pedidas nesta rodada EM PARALELO (ordem preservada)
      const platsArr = Array.isArray(plataforma) ? plataforma : (plataforma ? [plataforma] : []);
      const respParts = await Promise.all(fnCalls.map(async (p) => {
        let out;
        try { out = await executarTool(p.functionCall.name, p.functionCall.args || {}, platsArr, criterios); }
        catch (e) { out = { erro: String(e.message) }; }
        for (const x of JSON.stringify(out ?? {}).matchAll(/"id":(\d+)/g)) idsConfirmados.add(Number(x[1]));
        if (p.functionCall.name === "validar_titulos" && out?.disponiveis) validados.push(...out.disponiveis);
        return { functionResponse: { name: p.functionCall.name, response: wrapResult(out) } };
      }));
      contents.push({ role: "user", parts: respParts });
      continue;
    }

    const texto = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();
    // Resposta vazia depois das ferramentas (acontece nos modelos lite): pede a resposta de novo, 1 vez
    if (!texto && !jaCobrouVazio) {
      jaCobrouVazio = true;
      console.warn(`[val] resposta vazia (finishReason=${cand?.finishReason}) — pedindo de novo`);
      contents.push({ role: "user", parts: [{ text: "[sistema, não é a pessoa] Sua última resposta veio vazia. Responda agora à pessoa usando os filmes que as ferramentas já confirmaram (se precisar, valide mais)." }] });
      continue;
    }
    // Citou filme sem confirmar em ferramenta? Manda validar antes de responder (1 vez).
    const naoConfirmados = [...texto.matchAll(/\[FILME:(\d+)\|([^|\]]*)/g)]
      .filter((x) => !idsConfirmados.has(Number(x[1]))).map((x) => x[2].trim() || x[1]);
    if (naoConfirmados.length && !jaCobrou) {
      jaCobrou = true;
      console.warn(`[val] ${naoConfirmados.length} card(s) sem validação — pedindo pra validar`);
      contents.push({ role: "model", parts: [{ text: texto }] });
      contents.push({ role: "user", parts: [{ text: `[sistema, não é a pessoa] Você citou filmes sem confirmar disponibilidade: ${naoConfirmados.join(", ")}. Chame validar_titulos com eles (e outros candidatos, se quiser) e reescreva a resposta inteira usando só ids devolvidos pela ferramenta.` }] });
      continue;
    }
    return { texto: texto || "Me embananei procurando aqui. Pergunta de novo?", idsConfirmados, validados };
  }
  return { texto: "Me embananei procurando aqui. Pergunta de novo?", idsConfirmados: new Set() };
}

/* ---------- servidor ---------- */
const app = express();
app.use(express.json());
// Dados reais (pôster, nota, duração, plataformas) pra demonstração animada da página inicial.
// Não usa o Gemini — só TMDB/OMDb, com cache.
app.get("/api/demo", async (req, res) => {
  try {
    const ids = String(req.query.ids || "").split(",").map(Number).filter((n) => n > 0).slice(0, 6);
    const filmes = (await Promise.all(ids.map((id) => enriquecerFilme(id)))).filter(Boolean)
      .map((d) => ({ id: d.id, titulo: d.titulo, ano: d.ano, capa: d.capa, notaImdb: d.notaImdb, nota: d.nota,
        duracao: d.duracao, classificacao: d.classificacao, plataformas: d.plataformas }));
    res.set("Cache-Control", "public, max-age=3600").json({ filmes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ filmes: [] });
  }
});

// Rota /chat serve a aplicação principal (chat com a Val)
app.get("/chat", (_req, res) => res.sendFile("chat.html", { root: "public" }));

// Estáticos: serve landing (/) e qualquer outro arquivo de public/
app.use(express.static("public"));

// Traduz cards já renderizados ([[VHSCARD:base64]]) pra texto simples que a Val entende,
// sem expor o formato interno. Ex.: "[já mostrado: A Chegada (2016)]".
function cardsParaTexto(texto) {
  return String(texto ?? "").replace(/\[\[VHSCARD:([A-Za-z0-9+/=]+)\]\]/g, (_orig, b64) => {
    try {
      const d = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      return `[já mostrado: ${d.titulo}${d.ano ? ` (${d.ano})` : ""} · id ${d.id}]`;
    } catch {
      return "[filme já mostrado]";
    }
  });
}

// Resumo curto pra Val: o que o usuário tem na lista e o que já viu.
function resumirContextoUsuario(historico, watchlist) {
  const linhas = [];
  if (watchlist.length) {
    const aVer = watchlist.filter((w) => !w.assistido && w.rating !== "nao_curti").map((w) => String(w.titulo).slice(0, 80));
    const vistosSemRating = watchlist.filter((w) => w.assistido && !w.rating).map((w) => String(w.titulo).slice(0, 80));
    const amados = watchlist.filter((w) => w.rating === "amei").map((w) => String(w.titulo).slice(0, 80));
    const naoCurtiu = watchlist.filter((w) => w.rating === "nao_curti").map((w) => String(w.titulo).slice(0, 80));
    if (amados.length) linhas.push(`AMOU (use como referência forte — pessoa adora esse tipo de filme): ${amados.slice(0, 15).join(", ")}.`);
    if (naoCurtiu.length) linhas.push(`NÃO CURTIU (NÃO recomendar parecidos): ${naoCurtiu.slice(0, 15).join(", ")}.`);
    if (vistosSemRating.length) linhas.push(`Já viu (prefira outros se houver, mas se for o melhor encaixe pro pedido atual, pode citar de novo): ${vistosSemRating.slice(0, 15).join(", ")}.`);
    if (aVer.length) linhas.push(`Fitas separadas pra ver depois (já tá no radar dela): ${aVer.slice(0, 10).join(", ")}.`);
  }
  // historico = pedidos de conversas ANTERIORES (strings guardadas no navegador)
  const pedidosAntigos = historico.map((t) => `"${String(t).slice(0, 120)}"`);
  if (pedidosAntigos.length) {
    linhas.push(`Em conversas anteriores essa pessoa já pediu: ${pedidosAntigos.join("; ")}. Use só pra conhecer o gosto dela — NÃO é o assunto de agora.`);
  } else {
    linhas.push("É a primeira conversa dessa pessoa. Cumprimente sem tratar como íntimo.");
  }
  return linhas.join("\n");
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, plataformas, plataforma, watchlist, pedidosAnteriores } = req.body || {};
    const plats = Array.isArray(plataformas) ? plataformas : (plataformas ? [plataformas] : (plataforma ? [plataforma] : ["Todos"]));

    // Conversa ATUAL vem do navegador. Cards renderizados viram texto simples pra Val.
    const sessao = (Array.isArray(messages) ? messages : []).slice(-30).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: cardsParaTexto(m.content),
    }));
    if (!sessao.length) return res.status(400).json({ erro: "Manda alguma coisa pra Val." });

    // Sem login: lista de fitas e pedidos anteriores ficam no navegador e chegam aqui como contexto.
    const textosSessao = new Set(sessao.filter((m) => m.role === "user").map((m) => m.content.trim()));
    const historico = (Array.isArray(pedidosAnteriores) ? pedidosAnteriores : [])
      .map(String).filter((t) => !textosSessao.has(t.trim())).slice(-10);
    const fitas = (Array.isArray(watchlist) ? watchlist : []).slice(0, 200);
    const contextoUsuario = resumirContextoUsuario(historico, fitas);

    const criterios = extrairCriterios(sessao);
    const { texto: replyRaw, idsConfirmados, validados } = await conversar(sessao, plats, contextoUsuario, criterios);
    const reply = await enriquecerResposta(replyRaw, plats, idsConfirmados, validados, criterios);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Deu ruído na fita aqui no servidor." });
  }
});

const PORT = process.env.PORT || 3000;
Promise.all([carregarProvedores(), carregarGeneros(), garantirRadar()])
  .then(() => app.listen(PORT, () => console.log(`\n🎬 VHS Club no ar! Abra http://localhost:${PORT}\n`)))
  .catch((e) => { console.error("Erro ao iniciar (cheque a TMDB_KEY):", e.message); process.exit(1); });
