/* Banco de sugestões do VHS Club — usado na página inicial e na primeira tela do chat.
   Cada rodada sorteia 1 de cada PAPEL, pra nunca ficar tudo abstrato nem tudo ficção científica:
   - facil:      tema fácil de reconhecer
   - inesperada: combinação que a pessoa nem imaginava que podia pedir
   - momento:    mostra que a Val entende o momento/condição da pessoa
   Pra adicionar ideias, é só acrescentar frases nas listas abaixo. */
(function () {
  const BANCO = {
    facil: [
      "Quero um filme de ET",
      "Algo parecido com Interestelar",
      "Uma comédia pra desligar a cabeça",
      "Suspense sem terror",
      "Quero uma invasão alienígena vista por pessoas comuns",
      "Primeiro contato com ETs, com mais mistério do que tiro",
      "Um filme em que os aliens já estão entre nós",
      "ET, conspiração e governo escondendo alguma coisa",
      "Vida fora da Terra de um jeito que pareça possível",
      "Filmes com plot twist",
      "Filme brasileiro bom",
      "Filmes baseados em fatos reais",
      "Filme de assalto e golpe",
      "Um filme pra chorar",
    ],
    inesperada: [
      "Quero um filme que me faça questionar a realidade",
      "Uma comédia que me dê uma crise existencial",
      "Filmes sobre livre-arbítrio: a gente escolhe alguma coisa mesmo?",
      "Quero filosofia sem parecer que estou assistindo a uma aula",
      "Um filme sobre o que significa ser humano",
      "Ficção científica com questões espirituais",
      "Uma história de amor que envolva viagem no tempo",
      "Um suspense sobre memórias que talvez sejam falsas",
      "Uma distopia que faça pensar no mundo de hoje",
      "Uma sociedade aparentemente perfeita que esconde algo terrível",
      "Quero sentir saudade de uma época que nem vivi",
      "Um filme que comece normal e fique cada vez mais estranho",
      "Algo que pareça um sonho que eu não consigo explicar",
    ],
    momento: [
      "Quero um filme inteligente, mas estou cansado",
      "Um terror que incomode sem depender de sustos",
      "Algo parecido com Interestelar, só que menos triste",
      "Uma história sobre solidão que também seja acolhedora",
      "Um filme bom pra duas pessoas que nunca concordam no que assistir",
      "Quero terminar o filme e precisar conversar sobre ele",
      "Quero voltar a acreditar um pouco nas pessoas",
      "Tenho só 90 minutos",
    ],
  };

  // Prateleiras da Val: nome com personalidade + o pedido que vai pro chat
  const PRATELEIRAS = [
    { nome: "ET sem guerra espacial", pedido: "Quero filme de ET com mais mistério do que tiro" },
    { nome: "Suspense pra desconfiar de todo mundo", pedido: "Suspense em que dá pra desconfiar de todo mundo" },
    { nome: "Hoje eu só quero dar risada", pedido: "Hoje eu só quero dar risada, comédia leve" },
    { nome: "Filosofia sem aula chata", pedido: "Quero filosofia sem parecer que estou assistindo a uma aula" },
    { nome: "Terror que incomoda sem susto barato", pedido: "Um terror que incomode sem depender de sustos" },
    { nome: "Pra voltar a acreditar nas pessoas", pedido: "Quero voltar a acreditar um pouco nas pessoas" },
    { nome: "Cabeça cansada, mas nada bobo", pedido: "Quero um filme inteligente, mas estou cansado" },
    { nome: "Amor e viagem no tempo", pedido: "Uma história de amor que envolva viagem no tempo" },
  ];

  let ultimaRodada = [];
  function sorteia(lista, evitar) {
    const opcoes = lista.filter((s) => !evitar.includes(s));
    const base = opcoes.length ? opcoes : lista;
    return base[Math.floor(Math.random() * base.length)];
  }
  // Uma de cada papel, sem repetir a rodada anterior; ordem embaralhada
  function rodada() {
    const r = ["facil", "inesperada", "momento"].map((papel) => sorteia(BANCO[papel], ultimaRodada));
    ultimaRodada = r;
    return r.sort(() => Math.random() - 0.5);
  }

  window.VHS_SUGESTOES = { rodada, PRATELEIRAS };
})();
