// Teste offline: mocka fetch pra simular Gemini + TMDB e prova que o
// loop de tool calling da Val funciona. Não chama internet de verdade.
// Rode com:  node --env-file=.env test-offline.mjs

process.env.TMDB_KEY ||= "fake";
process.env.GEMINI_KEY ||= "fake";

let geminiCallCount = 0;
const tmdbResponses = {
  "/watch/providers/movie": { results: [{ provider_id: 8, provider_name: "Netflix" }] },
  "/genre/movie/list": { genres: [{ id: 35, name: "Comédia" }] },
  "/discover/movie": { results: [
    { id: 111, title: "A Vida em Si", release_date: "2017-09-20", vote_average: 7.1 },
    { id: 222, title: "Comer, Rezar, Amar", release_date: "2010-08-13", vote_average: 6.5 },
  ]},
  "/movie/111/watch/providers": { results: { BR: { flatrate: [{ provider_id: 8, provider_name: "Netflix" }], link: "https://www.themoviedb.org/movie/111/watch?locale=BR" } } },
};

global.fetch = async (url, opts) => {
  const u = url.toString();
  // Gemini
  if (u.includes("generativelanguage.googleapis.com")) {
    geminiCallCount++;
    if (geminiCallCount === 1) {
      // 1ª resposta: a Val pede a ferramenta descobrir_na_plataforma
      return { ok: true, json: async () => ({
        candidates: [{ content: { role: "model", parts: [
          { functionCall: { name: "descobrir_na_plataforma", args: { plataforma: "Netflix", genero: "Comédia" } } }
        ]}}]
      })};
    }
    if (geminiCallCount === 2) {
      // 2ª resposta: a Val pede onde_assistir pra confirmar o filme escolhido
      return { ok: true, json: async () => ({
        candidates: [{ content: { role: "model", parts: [
          { functionCall: { name: "onde_assistir", args: { movie_id: 111 } } }
        ]}}]
      })};
    }
    // 3ª resposta: texto final da Val
    return { ok: true, json: async () => ({
      candidates: [{ content: { role: "model", parts: [
        { text: "Olha, pra um clima leve hoje na Netflix eu rebobinaria pra **A Vida em Si** — drama com momentos doces, bom pra noite tranquila. Tá na *Netflix* aqui no BR agora. 📼" }
      ]}}]
    })};
  }
  // TMDB
  for (const [path, resp] of Object.entries(tmdbResponses)) {
    if (u.includes(path)) return { ok: true, json: async () => resp };
  }
  console.warn("FETCH não tratado:", u);
  return { ok: true, json: async () => ({}) };
};

// Bloqueia process.exit pra não matar o teste durante o import
const realExit = process.exit;
process.exit = (code) => { if (code) throw new Error("server.js chamou exit("+code+")"); };

// Importa o server (vai inicializar PROVIDERS/GENEROS via fetch mockado, mas
// não conseguimos chamar conversar() de fora porque server.js não exporta nada.
// Então re-implementamos só o que importa: o conversar() copiado tal qual.)
process.exit = realExit;

// Replica EXATAMENTE o loop do server.js usando o fetch mockado:
const MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GEMINI_KEY = process.env.GEMINI_KEY;
const tools = [
  { name: "buscar_filme", description: "x", parameters: { type:"object", properties:{titulo:{type:"string"}}, required:["titulo"] } },
  { name: "filmes_parecidos", description: "x", parameters: { type:"object", properties:{movie_id:{type:"integer"},plataforma:{type:"string"}}, required:["movie_id"] } },
  { name: "descobrir_na_plataforma", description: "x", parameters: { type:"object", properties:{plataforma:{type:"string"},genero:{type:"string"}}, required:["plataforma"] } },
  { name: "onde_assistir", description: "x", parameters: { type:"object", properties:{movie_id:{type:"integer"}}, required:["movie_id"] } },
];

// Simulação leve de executarTool: só registra o que foi chamado e devolve algo plausível
const toolLog = [];
async function executarTool(nome, input) {
  toolLog.push({ nome, input });
  if (nome === "descobrir_na_plataforma") return [{ id: 111, titulo: "A Vida em Si", ano: "2017", nota: 7.1 }];
  if (nome === "onde_assistir") return { streaming: ["Netflix"], link: "https://www.themoviedb.org/movie/111/watch?locale=BR" };
  return [];
}

async function gemini(body) {
  const r = await fetch(GEMINI_URL, { method:"POST", headers:{"content-type":"application/json","x-goog-api-key":GEMINI_KEY}, body: JSON.stringify(body) });
  return r.json();
}
function wrapResult(out) { if (out && typeof out==="object" && !Array.isArray(out)) return out; return { result: out }; }

async function conversar(messages, plataforma) {
  const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content ?? "") }] }));
  const body = { systemInstruction: { parts: [{ text: `Val. Filtro: ${plataforma}.` }] }, tools: [{ functionDeclarations: tools }], generationConfig: { maxOutputTokens: 1024, temperature: 0.7 } };
  for (let i = 0; i < 6; i++) {
    const resp = await gemini({ ...body, contents });
    const parts = resp.candidates?.[0]?.content?.parts || [];
    const fnCalls = parts.filter(p => p.functionCall);
    if (fnCalls.length > 0) {
      contents.push({ role: "model", parts });
      const respParts = [];
      for (const p of fnCalls) {
        const out = await executarTool(p.functionCall.name, p.functionCall.args || {});
        respParts.push({ functionResponse: { name: p.functionCall.name, response: wrapResult(out) } });
      }
      contents.push({ role: "user", parts: respParts });
      continue;
    }
    return parts.filter(p => p.text).map(p => p.text).join("\n").trim();
  }
  return "loop estourou";
}

const messages = [{ role: "user", content: "quero um filme leve hoje na Netflix" }];
const reply = await conversar(messages, "Netflix");
console.log("---FERRAMENTAS CHAMADAS (em ordem)---");
toolLog.forEach((t,i) => console.log(`${i+1}. ${t.nome}(${JSON.stringify(t.input)})`));
console.log("---RESPOSTA FINAL DA VAL---");
console.log(reply);
console.log("---CHAMADAS AO GEMINI---", geminiCallCount);
