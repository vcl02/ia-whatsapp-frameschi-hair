import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import {
  AgendadorMinhaAgenda, DEF_PROPOR, contextoDoAgendamento, dataCurta, resumoDoAgendamento, montarFerramentas, receberComprovante, sinalDoServico, telefoneNacional, valorDoPreco,
  type DepsComprovante, type DepsFerramentas, type PedidoAgendamento, type Proposta, type RepositorioPropostas,
} from "../functions/_shared/agendamento.ts";
import type { Agenda } from "../functions/_shared/disponibilidade.ts";

Deno.test("sinal de 20%: valor do preço em texto, 'a partir de' usa o mínimo", () => {
  assertEquals(valorDoPreco("R$ 30,00"), 30);
  assertEquals(valorDoPreco("A partir de R$ 1.250,50"), 1250.5);
  assertEquals(valorDoPreco("sob consulta"), null);
  assertEquals(valorDoPreco(null), null);
  assertEquals(sinalDoServico("R$ 20,00"), { texto: "R$ 4,00", aPartirDe: false });
  assertEquals(sinalDoServico("A partir de R$ 60,00"), { texto: "R$ 12,00", aPartirDe: true });
  assertEquals(sinalDoServico("R$ 450,00", "Progressiva (A partir de)"), { texto: "R$ 90,00", aPartirDe: true });
  assertEquals(sinalDoServico("R$ 33,33")?.texto, "R$ 6,67");
  assertEquals(sinalDoServico("consultar"), null);
});

Deno.test("data curta com dia da semana", () => {
  assertEquals(dataCurta("2026-11-11"), "quarta-feira, 11/11");
});

Deno.test("telefone nacional a partir do wa_id", () => {
  assertEquals(telefoneNacional("5511992090474"), "11992090474");
  assertEquals(telefoneNacional("551133334444"), "1133334444");
  assertEquals(telefoneNacional("14155550123"), null);
});

Deno.test("agendador: login, cadastro com dados da cliente e POST no formato do site", async () => {
  const pedidos: Array<{ url: string; body: unknown }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    pedidos.push({ url: u.replace(/\?.*$/, ""), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes("accounts:signUp")) return new Response(JSON.stringify({ idToken: "tc", refreshToken: "r", expiresIn: "3600" }));
    if (u.includes("GuestSignUp")) return new Response("{}");
    return new Response(JSON.stringify({ status: "CREATED" }));
  }) as typeof fetch;
  const p: PedidoAgendamento = { nome: "Isa", telefone: "11992090474", profissionalId: 486643, servicoId: 5732343, data: "2026-11-20", hora: "09:00", comentario: "c" };
  await new AgendadorMinhaAgenda("KEY", f).agendar(p);
  const cad = pedidos[1].body as Record<string, unknown>;
  assertEquals([cad.name, cad.phone, cad.countryIso], ["Isa", "11992090474", "BR"]);
  assertEquals(pedidos[2].url, "https://apionline.maapp.com.br/currentUser/appointments");
  assertEquals(pedidos[2].body, { userCpf: null, appointmentsDto: [{ employeeId: 486643, comments: "c", date: "2026-11-20", startTime: "09:00", serviceIds: [5732343] }] });
});

Deno.test("agendador: resposta sem CREATED é erro", async () => {
  const f = (async (url: string) => String(url).includes("signUp")
    ? new Response(JSON.stringify({ idToken: "t", refreshToken: "r" }))
    : new Response(String(url).includes("appointments") ? JSON.stringify({ status: "ERROR" }) : "{}")) as typeof fetch;
  let erro = "";
  try {
    await new AgendadorMinhaAgenda("K", f).agendar({ nome: "a", telefone: "1", profissionalId: 1, servicoId: 1, data: "2026-11-20", hora: "09:00", comentario: "" });
  } catch (e) { erro = String(e); }
  assertStringIncludes(erro, "não criou");
});

// ---------- fluxo propor -> comprovante ----------

class PropostasMemoria implements RepositorioPropostas {
  itens: Array<Proposta & { status: string; detalhe?: string }> = [];
  criar(p: Omit<Proposta, "id" | "criadoEm">) {
    for (const x of this.itens) if (x.conversaId === p.conversaId && x.status === "proposto") x.status = "substituido";
    const n = { ...p, id: `p${this.itens.length + 1}`, status: "proposto", criadoEm: AGORA.getTime() };
    this.itens.push(n);
    return Promise.resolve(n);
  }
  pendente(c: string) { return Promise.resolve([...this.itens].reverse().find((x) => x.conversaId === c && x.status === "proposto") ?? null); }
  mudarStatus(id: string, de: string, para: string, detalhe?: string) {
    const x = this.itens.find((i) => i.id === id && i.status === de);
    if (x) { x.status = para; if (detalhe) x.detalhe = detalhe; }
    return Promise.resolve(!!x);
  }
  agendadosDesde(c: string) { return Promise.resolve(this.itens.filter((x) => x.conversaId === c && x.status === "agendado").length); }
  recente(c: string) {
    const x = [...this.itens].reverse().find((i) => i.conversaId === c);
    return Promise.resolve(x ? { ...x, atualizadoEm: this.atualizadoEm ?? x.criadoEm } : null);
  }
  atualizadoEm?: number;
  cancelamentosPedidos: string[] = [];
  agendadoAtivo(c: string, hoje: string) {
    const x = [...this.itens].reverse().find((i) => i.conversaId === c && i.status === "agendado" && i.data >= hoje);
    return Promise.resolve(x ?? null);
  }
  async marcarCancelamentoPedido(c: string, hoje: string) {
    const x = await this.agendadoAtivo(c, hoje);
    if (!x) return null;
    this.cancelamentosPedidos.push(x.id);
    return resumoDoAgendamento(x);
  }
}

const AGORA = new Date("2026-11-07T12:00:00Z");
const SERVICOS = [
  { origem_id: 5732343, nome: "Banho de Lua", preco: "R$ 30,00" },
  { origem_id: 9, nome: "Progressiva (A partir de)", preco: "R$ 450,00" },
  { origem_id: 8, nome: "Sob consulta", preco: "consultar" },
];
const PIX = { chave: "11999990000", titular: "Bruna Frameschi" };

function cenario(opcoes: { livre?: boolean; falharAgendamento?: boolean; semPix?: boolean; semLimiteDiario?: boolean } = {}) {
  const propostas = new PropostasMemoria();
  const agendados: PedidoAgendamento[] = [];
  const avisos: Array<[string, string]> = [];
  let livre = opcoes.livre ?? true;
  let agoraAtual = AGORA;
  const consulta = { vagas: (_s: number, data: string): Promise<Agenda> => Promise.resolve({ data, feriado: false, profissionais: [
    { id: 486643, nome: "Bruna", horarios: livre ? ["09:00", "11:00"] : ["11:00"] },
    { id: 1001243, nome: "Alessandra", horarios: [] },
  ] }) };
  const agendador = { agendar: (p: PedidoAgendamento) => opcoes.falharAgendamento ? Promise.reject(new Error("HTTP 409")) : (agendados.push(p), Promise.resolve()) };
  const comuns = { avisar: (a: string, t: string) => (avisos.push([a, t]), Promise.resolve()), log: () => {}, agora: () => agoraAtual };
  const deps: DepsFerramentas = { consulta, agendador, propostas, pix: opcoes.semPix ? undefined : PIX, maxDias: 15, ...comuns };
  const depsComp: DepsComprovante = { consulta, agendador, propostas, semLimiteDiario: opcoes.semLimiteDiario, ...comuns };
  return {
    propostas, agendados, avisos,
    ferramentas: () => montarFerramentas({ conversaId: "c1", waId: "5511992090474", servicos: SERVICOS }, deps),
    comprovante: (tipo = "image", conversa = "c1") => receberComprovante({ conversaId: conversa, waId: "5511992090474" }, depsComp, tipo),
    ocupar: () => { livre = false; },
    avancar: (ms: number) => { agoraAtual = new Date(agoraAtual.getTime() + ms); },
  };
}

const PROPOSTA = { servico_id: 5732343, data: "2026-11-10", hora: "09:00", profissional: "Bruna", nome_cliente: "Isa" };

Deno.test("oferece consulta e proposta (a IA não tem ferramenta para agendar)", () => {
  assertEquals(cenario().ferramentas().definicoes.map((d) => d.name), ["consultar_horarios", DEF_PROPOR.name]);
});

Deno.test("só consulta quando o agendamento está desligado", async () => {
  const f = montarFerramentas({ conversaId: "c1", waId: "5511992090474", servicos: SERVICOS },
    { consulta: { vagas: () => Promise.reject(new Error("x")) }, avisar: () => Promise.resolve(), log: () => {}, maxDias: 15, agora: () => AGORA });
  assertEquals(f.definicoes.map((d) => d.name), ["consultar_horarios"]);
  assertStringIncludes(await f.executar("confirmar_agendamento", {}), "desconhecida");
});

Deno.test("proposta devolve resumo, sinal de 20% e chave Pix, e não agenda", async () => {
  const c = cenario();
  const r = await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  assertStringIncludes(r, "R$ 6,00");
  assertStringIncludes(r, "11999990000");
  assertStringIncludes(r, "Bruna Frameschi");
  assertStringIncludes(r, "Ainda NÃO está agendado");
  assertEquals(c.agendados.length, 0);
  assertEquals(c.propostas.itens[0].expiraEm, AGORA.getTime() + 30 * 60_000);
});

Deno.test("serviço 'a partir de': sinal sobre o mínimo, avisando que a Bruna confirma", async () => {
  const r = await cenario().ferramentas().executar("propor_agendamento", { ...PROPOSTA, servico_id: 9 });
  assertStringIncludes(r, "R$ 90,00");
  assertStringIncludes(r, "valor mínimo");
});

Deno.test("sem chave Pix ou sem valor legível: não propõe, chama a Bruna", async () => {
  assertStringIncludes(await cenario({ semPix: true }).ferramentas().executar("propor_agendamento", PROPOSTA), "passar_para_humano = true");
  const c = cenario();
  assertStringIncludes(await c.ferramentas().executar("propor_agendamento", { ...PROPOSTA, servico_id: 8 }), "calcular o sinal");
  assertEquals(c.propostas.itens.length, 0);
});

Deno.test("comprovante com proposta pendente: agenda, avisa a equipe e responde", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  const r = await c.comprovante("image");
  assertEquals(r?.acao, "responder");
  assertStringIncludes((r as { texto: string }).texto, "terça-feira, 10/11");
  assertEquals(c.agendados[0], { nome: "Isa", telefone: "11992090474", profissionalId: 486643, servicoId: 5732343, data: "2026-11-10", hora: "09:00", comentario: "Agendado pelo assistente virtual do WhatsApp (sinal Pix)" });
  assertEquals(c.propostas.itens[0].status, "agendado");
  assertEquals(c.propostas.itens[0].detalhe, "comprovante recebido (image)");
  assertEquals(c.avisos.length, 1);
  assertStringIncludes(c.avisos[0][1], "confira o Pix");
  assertStringIncludes(c.avisos[0][1], "R$ 6,00");
});

Deno.test("segundo comprovante logo depois de agendar é ignorado", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  await c.comprovante("image");
  assertEquals(await c.comprovante("document"), { acao: "ignorar" });
  assertEquals(c.agendados.length, 1);
});

Deno.test("imagem sem proposta pendente: devolve null (segue o caminho normal)", async () => {
  assertEquals(await cenario().comprovante(), null);
});

Deno.test("proposta vencida: não agenda e chama a Bruna", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  c.avancar(31 * 60_000);
  const r = await c.comprovante();
  assertEquals(r?.acao, "humano");
  assertEquals(c.agendados.length, 0);
  assertEquals(c.propostas.itens[0].status, "expirado");
});

Deno.test("horário ocupado entre a proposta e o comprovante: não agenda e chama a Bruna", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  c.ocupar();
  const r = await c.comprovante();
  assertEquals(r?.acao, "humano");
  assertStringIncludes((r as { motivo: string }).motivo, "Banho de Lua");
  assertEquals(c.agendados.length, 0);
  assertEquals(c.propostas.itens[0].status, "falhou");
});

Deno.test("erro do Minha Agenda: registra falha e chama a Bruna", async () => {
  const c = cenario({ falharAgendamento: true });
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  assertEquals((await c.comprovante())?.acao, "humano");
  assertEquals(c.propostas.itens[0].status, "falhou");
  assertEquals(c.avisos.length, 0);
});

Deno.test("um agendamento por conversa por dia, mesmo com comprovante", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  await c.comprovante();
  c.avancar(2 * 60 * 60_000); // passou a janela de "segundo comprovante" (1 h), mas não as 24 h
  await c.ferramentas().executar("propor_agendamento", { ...PROPOSTA, hora: "11:00" });
  assertEquals((await c.comprovante())?.acao, "humano");
  assertEquals(c.agendados.length, 1);
});

Deno.test("proposta valida profissional, horário, nome e serviço", async () => {
  const f = cenario().ferramentas();
  assertStringIncludes(await f.executar("propor_agendamento", { ...PROPOSTA, profissional: "Joana" }), "Opções: Bruna, Alessandra");
  assertStringIncludes(await f.executar("propor_agendamento", { ...PROPOSTA, hora: "10:00" }), "não está mais livre");
  assertStringIncludes(await f.executar("propor_agendamento", { ...PROPOSTA, hora: "9h" }), "HH:MM");
  assertStringIncludes(await f.executar("propor_agendamento", { ...PROPOSTA, nome_cliente: " " }), "falta o nome");
  assertStringIncludes(await f.executar("propor_agendamento", { ...PROPOSTA, servico_id: 1 }), "serviço não encontrado");
  assertStringIncludes(await f.executar("propor_agendamento", { ...PROPOSTA, data: "2026-12-30" }), "15 dias");
});

Deno.test("nova proposta substitui a anterior e o comprovante agenda a última", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  await c.ferramentas().executar("propor_agendamento", { ...PROPOSTA, hora: "11:00" });
  assertEquals(c.propostas.itens.map((i) => i.status), ["substituido", "proposto"]);
  await c.comprovante();
  assertEquals(c.agendados[0].hora, "11:00");
});

Deno.test("contexto da IA: proposta pendente, agendamento recente e nada", async () => {
  const c = cenario();
  const sem = () => Promise.resolve();
  assertEquals(await contextoDoAgendamento(c.propostas, "c1", AGORA, sem), null);
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  assertStringIncludes((await contextoDoAgendamento(c.propostas, "c1", AGORA, sem))!, "aguardando o comprovante");
  await c.comprovante();
  c.propostas.atualizadoEm = AGORA.getTime();
  const feito = (await contextoDoAgendamento(c.propostas, "c1", new Date(AGORA.getTime() + 60_000), sem))!;
  assertStringIncludes(feito, "acabou de agendar");
  assertStringIncludes(feito, "deixe \"resposta\" vazia");
  // 10 minutos depois não é mais "acabou de agendar", mas o agendamento segue ativo (futuro)
  const depois = (await contextoDoAgendamento(c.propostas, "c1", new Date(AGORA.getTime() + 10 * 60_000), sem))!;
  assertEquals(depois.includes("acabou de agendar"), false);
  assertStringIncludes(depois, "Agendamento ativo desta cliente");
});

Deno.test("contexto da IA: espera o comprovante em processamento terminar", async () => {
  const c = cenario();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  c.propostas.itens[0].status = "agendando";
  let esperas = 0;
  const esperar = () => { esperas++; if (esperas === 2) c.propostas.itens[0].status = "agendado"; return Promise.resolve(); };
  c.propostas.atualizadoEm = AGORA.getTime();
  assertStringIncludes((await contextoDoAgendamento(c.propostas, "c1", AGORA, esperar))!, "acabou de agendar");
  assertEquals(esperas, 2);
});

Deno.test("número de teste não tem o limite de 1 agendamento por dia (agenda de novo)", async () => {
  const c = cenario({ semLimiteDiario: true });
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  await c.comprovante();
  c.avancar(2 * 60 * 60_000);
  await c.ferramentas().executar("propor_agendamento", { ...PROPOSTA, hora: "11:00" });
  assertEquals((await c.comprovante())?.acao, "responder");
  assertEquals(c.agendados.length, 2);
});

Deno.test("contexto da IA: agendamento ativo traz o roteiro de cancelamento; passado não conta", async () => {
  const c = cenario();
  const sem = () => Promise.resolve();
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  await c.comprovante();
  c.propostas.atualizadoEm = AGORA.getTime();
  // 1 dia depois da proposta (10/11 ainda no futuro): sai do bloco de "acabou de agendar" mas segue ativo
  const depois = new Date(AGORA.getTime() + 24 * 60 * 60_000);
  const t = (await contextoDoAgendamento(c.propostas, "c1", depois, sem))!;
  assertStringIncludes(t, "Agendamento ativo desta cliente");
  assertStringIncludes(t, "Banho de Lua, terça-feira, 10/11, às 09:00, com Bruna, no nome de Isa, sinal de R$ 6,00");
  assertStringIncludes(t, "remarcar_ou_cancelar");
  assertStringIncludes(t, "O sinal NÃO é devolvido");
  // depois do dia do agendamento, não é mais ativo
  assertEquals(await contextoDoAgendamento(c.propostas, "c1", new Date("2026-11-12T12:00:00Z"), sem), null);
});

Deno.test("marcar pedido de cancelamento devolve o resumo; sem agendamento ativo devolve null", async () => {
  const c = cenario();
  assertEquals(await c.propostas.marcarCancelamentoPedido("c1", "2026-11-07"), null);
  await c.ferramentas().executar("propor_agendamento", PROPOSTA);
  await c.comprovante();
  const r = await c.propostas.marcarCancelamentoPedido("c1", "2026-11-07");
  assertStringIncludes(r!, "Banho de Lua");
  assertEquals(c.propostas.cancelamentosPedidos.length, 1);
});
