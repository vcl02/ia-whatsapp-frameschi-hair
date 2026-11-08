import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { LIMITE_GLOBAL_DIA, LIMITE_POR_CONVERSA_HORA, processarMensagem, type Conversa, type DepsBot, type Repositorio } from "../functions/_shared/bot.ts";
import type { Atendente, DecisaoLLM, ItemHistorico } from "../functions/_shared/llm.ts";
import type { MensagemRecebida, ResultadoEnvio } from "../functions/_shared/whatsapp.ts";
import { SALAO, type DadosSalao, type Servico } from "../functions/_shared/salao.ts";
import { SERVICOS_TESTE } from "./salao_teste.ts";

class RepoFake implements Repositorio {
  c: Conversa = { id: "c1", waId: "55", nomePerfil: "Ana", botPausado: false };
  ultima = "wamid.1";
  servicos: Servico[] = SERVICOS_TESTE;
  jaRespondeu = true;
  saidas: { autor: string; texto: string }[] = [];
  humano: string | null = null;
  pausarDuranteLLM = false;
  cfg = { modelo: "claude-sonnet-5-5", esforco: "medium" as const, limiteConversaHora: LIMITE_POR_CONVERSA_HORA, limiteGlobalDia: LIMITE_GLOBAL_DIA };
  config() { return Promise.resolve(this.cfg); }
  respostasConversaHora = 0;
  respostasGlobaisDia = 0;
  respostasDoBot(conversaId: string | null) { return Promise.resolve(conversaId ? this.respostasConversaHora : this.respostasGlobaisDia); }
  conversa() { return Promise.resolve({ ...this.c }); }
  historico(): Promise<ItemHistorico[]> { return Promise.resolve([{ autor: "cliente", texto: "oi" }]); }
  ultimaEntradaWamid() { return Promise.resolve(this.ultima); }
  temSaida() { return Promise.resolve(this.jaRespondeu); }
  servicosAtivos() { return Promise.resolve(this.servicos); }
  info: Record<string, string> = {};
  infoSalao() { return Promise.resolve(this.info); }
  registrarSaida(_c: string, autor: "bot" | "humano", texto: string) { this.saidas.push({ autor, texto }); return Promise.resolve(); }
  marcarHumano(_c: string, motivo: string) { this.humano = motivo; this.c.botPausado = true; return Promise.resolve(); }
}

function msg(p: Partial<MensagemRecebida> = {}): MensagemRecebida {
  return { wamid: "wamid.1", waId: "55", nomePerfil: null, tipo: "text", texto: "Quanto custa a escova?", recebidaEm: new Date(), ...p };
}

function montar(decisao: DecisaoLLM | Error) {
  const repo = new RepoFake();
  const enviados: string[] = [];
  const avisos: string[] = [];
  let chamadasLLM = 0;
  const salaoRecebido: { valor?: DadosSalao } = {};
  const atendente: Atendente = {
    responder: (_h, _s, salao) => {
      salaoRecebido.valor = salao;
      chamadasLLM++;
      if (repo.pausarDuranteLLM) repo.c.botPausado = true;
      return decisao instanceof Error ? Promise.reject(decisao) : Promise.resolve(decisao);
    },
  };
  const deps: DepsBot = {
    repo, atendente, salao: SALAO,
    enviar: (_p, t): Promise<ResultadoEnvio> => { enviados.push(t); return Promise.resolve({ ok: true, wamid: "w", httpStatus: 200, erro: null }); },
    avisar: (_c, motivo) => { avisos.push(motivo); return Promise.resolve(); },
    esperar: () => Promise.resolve(),
    aleatorio: () => 0,
    log: () => {},
  };
  return { repo, deps, enviados, avisos, salaoRecebido, llm: () => chamadasLLM };
}

const ok: DecisaoLLM = { resposta: "A escova é R$ 50!", passar_para_humano: false, motivo: "", intencao: "duvida" };

Deno.test("responde com a LLM quando está tudo configurado", async () => {
  const t = montar(ok);
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "respondido");
  assertEquals(t.enviados, ["A escova é R$ 50!"]);
  assertEquals(t.repo.humano, null);
  assertEquals(t.avisos.length, 0);
});

Deno.test("primeira resposta da conversa leva a apresentação", async () => {
  const t = montar(ok);
  t.repo.jaRespondeu = false;
  await processarMensagem(t.deps, "c1", msg());
  assertEquals(t.enviados, [`${SALAO.mensagensApresentacao[0]}\n\nA escova é R$ 50!`]);
});

Deno.test("conversa pausada: não responde nem chama a LLM", async () => {
  const t = montar(ok);
  t.repo.c.botPausado = true;
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "pausado");
  assertEquals(t.enviados.length + t.llm(), 0);
});

Deno.test("mensagem mais recente na fila: esta não responde", async () => {
  const t = montar(ok);
  t.repo.ultima = "wamid.2";
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "substituida_por_mais_recente");
  assertEquals(t.enviados.length, 0);
});

Deno.test("áudio passa para humano, avisa a equipe e não chama a LLM", async () => {
  const t = montar(ok);
  assertEquals(await processarMensagem(t.deps, "c1", msg({ tipo: "audio", texto: null })), "passado_para_humano");
  assertEquals(t.llm(), 0);
  assertEquals(t.repo.c.botPausado, true);
  assertStringIncludes(t.enviados[0], "só consigo ler texto");
  assertEquals(SALAO.mensagensPassagemHumano.some((m) => t.enviados[0].endsWith(m)), true);
  assertEquals(t.avisos.length, 1);
});

Deno.test("pedido de atendente passa para humano", async () => {
  const t = montar(ok);
  assertEquals(await processarMensagem(t.deps, "c1", msg({ texto: "quero falar com uma atendente" })), "passado_para_humano");
  assertEquals(t.llm(), 0);
});

Deno.test("sem serviços cadastrados: não chama a LLM", async () => {
  const t = montar(ok);
  t.repo.servicos = [];
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "passado_para_humano");
  assertEquals(t.llm(), 0);
});

Deno.test("falha da LLM passa para humano", async () => {
  const t = montar(new Error("timeout"));
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "passado_para_humano");
  assertEquals(t.repo.c.botPausado, true);
});

Deno.test("LLM pede humano: envia a resposta, pausa e avisa", async () => {
  const t = montar({ resposta: "Vou chamar a Bruna", passar_para_humano: true, motivo: "remarcação", intencao: "remarcar_ou_cancelar" });
  assertEquals(await processarMensagem(t.deps, "c1", msg({ texto: "preciso remarcar" })), "passado_para_humano");
  assertEquals(t.repo.humano, "remarcação");
  assertEquals(t.enviados, ["Vou chamar a Bruna"]);
  assertEquals(t.avisos, ["remarcação"]);
});

Deno.test("falha no aviso não impede a resposta à cliente", async () => {
  const t = montar(ok);
  t.deps.avisar = () => Promise.reject(new Error("meta fora"));
  assertEquals(await processarMensagem(t.deps, "c1", msg({ tipo: "image", texto: null })), "passado_para_humano");
  assertEquals(t.enviados.length, 1);
});

Deno.test("pausado enquanto a LLM pensava: descarta a resposta", async () => {
  const t = montar(ok);
  t.repo.pausarDuranteLLM = true;
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "pausado");
  assertEquals(t.enviados.length, 0);
});

Deno.test("limite por conversa: passa para humano sem chamar a LLM", async () => {
  const t = montar(ok);
  t.repo.respostasConversaHora = LIMITE_POR_CONVERSA_HORA;
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "passado_para_humano");
  assertEquals(t.llm(), 0);
  assertEquals(t.repo.c.botPausado, true);
});

Deno.test("limites vêm da configuração do painel", async () => {
  const t = montar(ok);
  t.repo.cfg = { ...t.repo.cfg, limiteConversaHora: 3 };
  t.repo.respostasConversaHora = 3;
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "passado_para_humano");
  assertEquals(t.llm(), 0);
  assertStringIncludes(t.repo.humano ?? "", "limite de 3 respostas");
});

Deno.test("limite global diário: passa para humano sem chamar a LLM", async () => {
  const t = montar(ok);
  t.repo.respostasGlobaisDia = LIMITE_GLOBAL_DIA;
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "passado_para_humano");
  assertEquals(t.llm(), 0);
});

Deno.test("abaixo dos limites: responde normalmente", async () => {
  const t = montar(ok);
  t.repo.respostasConversaHora = LIMITE_POR_CONVERSA_HORA - 1;
  t.repo.respostasGlobaisDia = LIMITE_GLOBAL_DIA - 1;
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "respondido");
});

Deno.test("escolher: sorteia entre as opções e nunca sai do intervalo", async () => {
  const { escolher } = await import("../functions/_shared/bot.ts");
  const ops = ["a", "b", "c"];
  assertEquals(escolher(ops, () => 0), "a");
  assertEquals(escolher(ops, () => 0.5), "b");
  assertEquals(escolher(ops, () => 0.9999), "c");
  assertEquals(escolher(ops, () => 1), "c");
});

Deno.test("textos fixos têm mais de uma variação", () => {
  assertEquals(SALAO.mensagensApresentacao.length > 1, true);
  assertEquals(SALAO.mensagensPassagemHumano.length > 1, true);
});

Deno.test("horário e regras do Minha Agenda chegam ao modelo", async () => {
  const t = montar(ok);
  t.repo.info = { horario_funcionamento: "terça, das 9h às 17h.", regras_agendamento: "Tolerância de 10 min." };
  await processarMensagem(t.deps, "c1", msg());
  assertEquals(t.salaoRecebido.valor?.horarioFuncionamento, "terça, das 9h às 17h.");
  assertEquals(t.salaoRecebido.valor?.regrasAgendamento, "Tolerância de 10 min.");
  assertEquals(t.salaoRecebido.valor?.endereco, SALAO.endereco); // endereço continua fixo
});

Deno.test("situação do agendamento da conversa é passada para a IA", async () => {
  const t = montar({ resposta: "ok", passar_para_humano: false, motivo: "", intencao: "agendar" });
  let recebida: string | null | undefined;
  t.deps.atendente = { responder: (_h, _s, _d, o) => (recebida = o?.contextoAgendamento, Promise.resolve({ resposta: "ok", passar_para_humano: false, motivo: "", intencao: "agendar" as const })) };
  t.deps.contextoAgendamento = () => Promise.resolve("Hidratação, 2026-11-11 às 09:00 com Bruna");
  await processarMensagem(t.deps, "c1", msg({ texto: "SIM" }));
  assertEquals(recebida, "Hidratação, 2026-11-11 às 09:00 com Bruna");
});

Deno.test("comprovante (imagem) com proposta: agenda sem chamar a IA e responde", async () => {
  const t = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  t.deps.receberComprovante = () => Promise.resolve({ acao: "responder", texto: "Recebi seu comprovante! Agendado." });
  const r = await processarMensagem(t.deps, "c1", msg({ tipo: "image", texto: null }));
  assertEquals(r, "respondido");
  assertEquals(t.llm(), 0);
  assertEquals(t.enviados, ["Recebi seu comprovante! Agendado."]);
  assertEquals(t.repo.humano, null);
});

Deno.test("comprovante que precisa da equipe: pausa, avisa e responde", async () => {
  const t = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  t.deps.receberComprovante = () => Promise.resolve({ acao: "humano", texto: "Vou chamar a Bruna.", motivo: "horário ocupado" });
  const r = await processarMensagem(t.deps, "c1", msg({ tipo: "document", texto: null }));
  assertEquals(r, "passado_para_humano");
  assertEquals(t.avisos, ["horário ocupado"]);
  assertEquals(t.enviados, ["Vou chamar a Bruna."]);
});

Deno.test("comprovante extra depois de agendar é ignorado (sem resposta nem pausa)", async () => {
  const t = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  t.deps.receberComprovante = () => Promise.resolve({ acao: "ignorar" });
  assertEquals(await processarMensagem(t.deps, "c1", msg({ tipo: "image", texto: null })), "ignorado");
  assertEquals(t.enviados, []);
  assertEquals(t.repo.humano, null);
});

Deno.test("imagem sem proposta pendente continua chamando a equipe", async () => {
  const t = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  t.deps.receberComprovante = () => Promise.resolve(null);
  assertEquals(await processarMensagem(t.deps, "c1", msg({ tipo: "image", texto: null })), "passado_para_humano");
  assertEquals(t.llm(), 0);
});

Deno.test("comprovante processado mesmo se chegou outra mensagem depois dele", async () => {
  const t = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  t.repo.ultima = "wamid.outra"; // chegou mensagem mais recente
  t.deps.receberComprovante = () => Promise.resolve({ acao: "responder", texto: "Agendado." });
  assertEquals(await processarMensagem(t.deps, "c1", msg({ tipo: "image", texto: null })), "respondido");
});

Deno.test("falha ao processar o comprovante chama a equipe", async () => {
  const t = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  t.deps.receberComprovante = () => Promise.reject(new Error("banco fora"));
  assertEquals(await processarMensagem(t.deps, "c1", msg({ tipo: "image", texto: null })), "passado_para_humano");
  assertEquals(t.avisos, ["falha ao processar o comprovante"]);
});

Deno.test("resposta vazia sem passar para humano: não manda nada (ex.: agradecimento logo depois de agendar)", async () => {
  const t = montar({ resposta: " ", passar_para_humano: false, motivo: "", intencao: "outro" });
  assertEquals(await processarMensagem(t.deps, "c1", msg({ texto: "obrigada!" })), "ignorado");
  assertEquals(t.enviados, []);
  assertEquals(t.repo.humano, null);
});

Deno.test("resposta vazia passando para humano: usa a mensagem de passagem", async () => {
  const t = montar({ resposta: "", passar_para_humano: true, motivo: "x", intencao: "outro" });
  assertEquals(await processarMensagem(t.deps, "c1", msg()), "passado_para_humano");
  assertEquals(t.enviados.length, 1);
});

Deno.test("toda passagem para a Bruna explica o motivo à cliente", async () => {
  const casos: Array<[string, (t: ReturnType<typeof montar>) => Promise<unknown>, string]> = [
    ["pediu pessoa", (t) => processarMensagem(t.deps, "c1", msg({ texto: "quero falar com uma atendente" })), "pediu para falar com uma pessoa"],
    ["falha da IA", (t) => processarMensagem(t.deps, "c1", msg()), "problema aqui para te responder"],
  ];
  const t1 = montar({ resposta: "x", passar_para_humano: false, motivo: "", intencao: "outro" });
  await casos[0][1](t1);
  assertStringIncludes(t1.enviados[0].toLowerCase(), casos[0][2].toLowerCase());
  const t2 = montar(new Error("api fora"));
  await casos[1][1](t2);
  assertStringIncludes(t2.enviados[0], casos[1][2]);
});
