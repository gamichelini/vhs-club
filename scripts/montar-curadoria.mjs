/**
 * Monta curadoria.json a partir de curadoria-fonte.json.
 * Resolve cada "Título original (ano)" pra um id da TMDB (uma vez só), pra o servidor
 * não precisar buscar título por título em cada conversa.
 *
 * Uso:  node --env-file=.env scripts/montar-curadoria.mjs
 * Idempotente: pode rodar quantas vezes quiser; reaproveita os ids já resolvidos.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) { console.error("Falta TMDB_KEY no .env"); process.exit(1); }

const fonte = JSON.parse(readFileSync("curadoria-fonte.json", "utf8"));
// Reaproveita ids já resolvidos numa rodada anterior (não refaz busca à toa)
const anterior = existsSync("curadoria.json") ? JSON.parse(readFileSync("curadoria.json", "utf8")) : null;
const resolvidosAntes = new Map();
for (const t of anterior?.temas || []) for (const g of t.grupos) for (const f of g.filmes) resolvidosAntes.set(f.pedido, f);

async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "pt-BR"); // params podem sobrescrever (a busca usa en-US)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    return r.json();
  }
  throw new Error("TMDB 429 persistente");
}

async function resolver(bruto) {
  const forcado = bruto.match(/#(\d+)\s*$/);
  if (forcado) {
    const d = await tmdb(`/movie/${forcado[1]}`);
    return { pedido: bruto, id: d.id, titulo: d.title, ano: +(d.release_date || "0").slice(0, 4) || null, aviso: null };
  }
  const m = bruto.replace(/\s*#\d+\s*$/, "").match(/^(.*?)\s*\((\d{4})\)\s*$/);
  const titulo = m ? m[1] : bruto;
  const ano = m ? +m[2] : null;
  // Busca em INGLÊS (a fonte usa o título em inglês/original) com e sem ano, junta os resultados.
  const buscas = [{ query: titulo, language: "en-US" }];
  if (ano) buscas.unshift({ query: titulo, language: "en-US", primary_release_year: ano });
  const pool = new Map();
  for (const p of buscas) for (const x of ((await tmdb("/search/movie", p)).results || []).slice(0, 10)) pool.set(x.id, x);
  const res = [...pool.values()];
  if (!res.length) return { pedido: bruto, id: null };

  // Escolha: 1) ano certo (±1), 2) título igual (inglês ou original), 3) mais votado.
  // (só o 1º resultado pegava curta obscuro; só votos pegava "Lua Nova" pra "Moon")
  const anoDe = (x) => +(x.release_date || "0").slice(0, 4);
  const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const alvo = norm(titulo);
  const bate = (x) => (norm(x.original_title) === alvo || norm(x.title) === alvo ? 0 : 1);
  const foraDoAno = (x) => (ano && Math.abs(anoDe(x) - ano) > 1 ? 1 : 0);
  const f = res.sort((a, b) => foraDoAno(a) - foraDoAno(b) || bate(a) - bate(b) || (b.vote_count || 0) - (a.vote_count || 0))[0];

  // Nome em português pra exibir
  const pt = await tmdb(`/movie/${f.id}`).catch(() => ({}));
  const anoAchado = anoDe(f);
  const aviso = foraDoAno(f) ? `ano ${anoAchado}` : bate(f) ? `título "${f.title}"` : null;
  return { pedido: bruto, id: f.id, titulo: pt.title || f.title, ano: anoAchado || null, aviso };
}

const unicos = [...new Set(fonte.temas.flatMap((t) => t.grupos.flatMap((g) => g.filmes)))];
const mapa = new Map();
let i = 0;
const fila = unicos.filter((b) => !resolvidosAntes.has(b));
unicos.filter((b) => resolvidosAntes.has(b)).forEach((b) => mapa.set(b, resolvidosAntes.get(b)));
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < fila.length) { const b = fila[i++]; mapa.set(b, await resolver(b).catch(() => ({ pedido: b, id: null }))); }
}));

const naoAchados = [], avisos = [];
const saida = {
  geradoEm: new Date().toISOString(),
  temas: fonte.temas.map((t) => ({
    id: t.id, pedidos: t.pedidos, nota: t.nota,
    grupos: t.grupos.map((g) => ({
      nome: g.nome,
      filmes: g.filmes.map((b) => mapa.get(b)).filter((f) => {
        if (!f?.id) { naoAchados.push(f?.pedido); return false; }
        if (f.aviso) avisos.push(`${f.pedido} → ${f.titulo} ${f.ano} (${f.aviso})`);
        return true;
      }).map(({ aviso, ...f }) => f),
    })),
  })),
};
writeFileSync("curadoria.json", JSON.stringify(saida, null, 1));
console.log(`✅ curadoria.json: ${saida.temas.length} temas, ${unicos.length} títulos únicos (${fila.length} buscados agora).`);
if (naoAchados.length) console.log(`⚠️  Não achados (${naoAchados.length}):\n  ${[...new Set(naoAchados)].join("\n  ")}`);
if (avisos.length) console.log(`⚠️  Conferir (ano ou título diferente) (${new Set(avisos).size}):\n  ${[...new Set(avisos)].join("\n  ")}`);

/* ---------- VETORES (pra Val reconhecer pedido DIGITADO parecido com um tema) ----------
   Cada frase de 'pedidos' + 'exemplos' vira um vetor (Gemini embeddings, grátis). O servidor compara o
   pedido da pessoa com esses vetores. Reaproveita os vetores de frases que não mudaram. */
const GEMINI_KEY = process.env.GEMINI_KEY;
if (!GEMINI_KEY) { console.log("⚠️  Sem GEMINI_KEY: vetores não gerados."); process.exit(0); }
const MODELO_EMB = "gemini-embedding-001", DIM = 256;
const vetAntes = existsSync("curadoria-vetores.json") ? JSON.parse(readFileSync("curadoria-vetores.json", "utf8")) : null;
const cacheVet = new Map();
if (vetAntes?.modelo === MODELO_EMB && vetAntes?.dim === DIM) for (const t of vetAntes.temas) for (const f of t.frases) cacheVet.set(f.texto, f.v);

const frases = fonte.temas.flatMap((t) => [...t.pedidos, ...(t.exemplos || [])].map((texto) => ({ tema: t.id, texto })));
const faltam = [...new Set(frases.map((f) => f.texto).filter((t) => !cacheVet.has(t)))];
// Free tier: 100 frases/minuto (cada frase do lote conta). Lotes de 90 com pausa de 1 min.
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
for (let k = 0; k < faltam.length; k += 90) {
  if (k) { console.log(`   ...${k}/${faltam.length} vetores, pausa de 1 min (limite grátis)`); await espera(61000); }
  const lote = faltam.slice(k, k + 90);
  let d;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO_EMB}:batchEmbedContents`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ requests: lote.map((text) => ({ model: `models/${MODELO_EMB}`, content: { parts: [{ text }] }, taskType: "SEMANTIC_SIMILARITY", outputDimensionality: DIM })) }),
    });
    d = await r.json();
    if (d.embeddings || d.error?.code !== 429) break;
    await espera(61000);
  }
  if (!d.embeddings) { console.error("Erro nos vetores:", JSON.stringify(d).slice(0, 300)); process.exit(1); }
  d.embeddings.forEach((e, j) => cacheVet.set(lote[j], e.values.map((x) => Math.round(x * 1e4) / 1e4)));
}
const vetores = { modelo: MODELO_EMB, dim: DIM, temas: fonte.temas.map((t) => ({ id: t.id, frases: [...t.pedidos, ...(t.exemplos || [])].map((texto) => ({ texto, v: cacheVet.get(texto) })) })) };
writeFileSync("curadoria-vetores.json", JSON.stringify(vetores));
console.log(`✅ curadoria-vetores.json: ${frases.length} frases (${faltam.length} calculadas agora).`);
