import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { montarMensagens, montarSistema, validarDecisao } from "../functions/_shared/llm.ts";
import { SERVICOS_TESTE } from "./salao_teste.ts";
import { SALAO } from "../functions/_shared/salao.ts";

Deno.test("histórico alterna papéis, começa e termina com a cliente", () => {
  const m = montarMensagens([
    { autor: "bot", texto: "msg antiga do bot" },
    { autor: "cliente", texto: "oi" },
    { autor: "cliente", texto: "quanto é a escova?" },
    { autor: "humano", texto: "R$ 50" },
    { autor: "cliente", texto: "obrigada" },
  ]);
  assertEquals(m.map((x) => x.role), ["user", "assistant", "user"]);
  assertEquals(m[0].content, "oi\nquanto é a escova?");
  assertEquals(m[1].content, "[Atendente humana] R$ 50");
});

Deno.test("prompt contém só os dados configurados", () => {
  const s = montarSistema(SALAO, SERVICOS_TESTE);
  assertStringIncludes(s, "Escova: R$ 50");
  assertStringIncludes(s, SALAO.linkAgendamento!);
  assertStringIncludes(s, "Bruna Frameschi Hair");
  assertStringIncludes(s, "Nunca invente");
  assertStringIncludes(s, "Seu nome é Lia");
  assertStringIncludes(s, "UM único parágrafo");
});

Deno.test("valida o formato da decisão", () => {
  assertEquals(validarDecisao({ resposta: "a", passar_para_humano: false, motivo: "", intencao: "duvida" })?.resposta, "a");
  assertEquals(validarDecisao({ resposta: "a", passar_para_humano: "não", motivo: "", intencao: "duvida" }), null);
  assertEquals(validarDecisao({ resposta: "a", passar_para_humano: false, motivo: "", intencao: "xpto" }), null);
  assertEquals(validarDecisao(null), null);
});

Deno.test("data e hora em São Paulo", async () => {
  const { agoraEmSaoPaulo, blocoAgora } = await import("../functions/_shared/llm.ts");
  // 2026-11-07 00:10 UTC = sexta 06/11 21:10 em São Paulo (UTC-3, sem horário de verão).
  const t = new Date("2026-11-07T00:10:00Z");
  assertEquals(agoraEmSaoPaulo(t), "sexta-feira, 06/11/2026, 21:10");
  assertStringIncludes(blocoAgora(t), "horário de Brasília");
});

Deno.test("prompt inclui as regras de agendamento quando existem", async () => {
  const { montarSistema } = await import("../functions/_shared/llm.ts");
  const s = montarSistema({ ...SALAO, regrasAgendamento: "Tolerância de atraso de 10 minutos." }, SERVICOS_TESTE);
  assertStringIncludes(s, "Regras do agendamento:\nTolerância de atraso de 10 minutos.");
});

// ---------- laço da ferramenta de horários, com cliente falso ----------
import { AtendenteClaude, type ClienteMensagens } from "../functions/_shared/llm.ts";
import { DEF_CONSULTAR } from "../functions/_shared/agendamento.ts";

function respostaFinal(resposta: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ resposta, passar_para_humano: false, motivo: "", intencao: "agendar" }) }] };
}

function clienteFalso(roteiro: unknown[]) {
  const pedidos: Record<string, unknown>[] = [];
  const cliente = { beta: { messages: { create: (p: unknown) => { pedidos.push(structuredClone(p) as Record<string, unknown>); return Promise.resolve(roteiro.shift()); } } } };
  return { cliente: cliente as unknown as ClienteMensagens, pedidos };
}

const SERVICOS_COM_ID = [{ origem_id: 5732343, nome: "Banho de Lua", preco: "R$ 30,00", duracao: "30 min" }];

Deno.test("modelo consulta horários e responde com o resultado", async () => {
  const { cliente, pedidos } = clienteFalso([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "consultar_horarios", input: { servico_id: 5732343, data: "2026-11-10" } }] },
    respostaFinal("Terça tem 9h e 11h com a Bruna!"),
  ]);
  const consultas: Array<[number, string]> = [];
  const atendente = new AtendenteClaude("x", () => new Date("2026-11-07T12:00:00Z"), cliente);
  const d = await atendente.responder([{ autor: "cliente", texto: "tem horário terça?" }], SERVICOS_COM_ID, SALAO, {
    nomeCliente: "Ana",
    ferramentas: {
      definicoes: [DEF_CONSULTAR],
      executar: (_n, e) => { consultas.push([Number(e.servico_id), String(e.data)]); return Promise.resolve("Bruna: 09:00, 11:00"); },
    },
  });
  assertEquals(d.resposta, "Terça tem 9h e 11h com a Bruna!");
  assertEquals(consultas, [[5732343, "2026-11-10"]]);
  assertEquals(pedidos.length, 2);
  const msgs = pedidos[1].messages as Array<{ role: string; content: unknown }>;
  assertEquals(msgs.at(-2)?.role, "assistant"); // turno do modelo devolvido sem mudança
  assertEquals((msgs.at(-1)?.content as Array<Record<string, unknown>>)[0], { type: "tool_result", tool_use_id: "t1", content: "Bruna: 09:00, 11:00" });
  assertEquals((pedidos[0].tools as unknown[]).length, 1);
  assertStringIncludes((pedidos[0].system as Array<{ text: string }>)[0].text, "Banho de Lua [id 5732343]");
  assertStringIncludes((pedidos[0].system as Array<{ text: string }>)[1].text, "Nome da cliente no perfil do WhatsApp: Ana");
});

Deno.test("sem ferramentas, não oferece nenhuma e pede o nome se não houver perfil", async () => {
  const { cliente, pedidos } = clienteFalso([respostaFinal("Pelo link você vê os horários!")]);
  const atendente = new AtendenteClaude("x", () => new Date(), cliente);
  await atendente.responder([{ autor: "cliente", texto: "tem horário?" }], SERVICOS_COM_ID, SALAO);
  assertEquals(pedidos[0].tools, undefined);
  assertStringIncludes((pedidos[0].system as Array<{ text: string }>)[1].text, "pergunte o nome");
});

Deno.test("se o modelo ignora a última chamada sem ferramentas e insiste em consultar, dá erro (vai para humano)", async () => {
  const chamada = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "consultar_horarios", input: { servico_id: 1, data: "2026-11-10" } }] };
  const { cliente } = clienteFalso(Array(9).fill(chamada));
  const atendente = new AtendenteClaude("x", () => new Date(), cliente);
  let erro = "";
  try {
    await atendente.responder([{ autor: "cliente", texto: "e quarta? e quinta?" }], SERVICOS_COM_ID, SALAO, {
      ferramentas: { definicoes: [DEF_CONSULTAR], executar: () => Promise.resolve("ok") },
    });
  } catch (e) { erro = String(e); }
  assertStringIncludes(erro, "stop_reason=tool_use");
});

Deno.test("proposta pendente entra no contexto da IA (o histórico não tem as chamadas de ferramenta)", async () => {
  const { blocoContexto } = await import("../functions/_shared/llm.ts");
  const t = new Date("2026-11-07T12:00:00Z");
  assertStringIncludes(blocoContexto(t, "Ana", "Hidratação, 2026-11-11 às 09:00 com Bruna"), "peça o comprovante");
  assertEquals(blocoContexto(t, "Ana").includes("Proposta pendente"), false);
  const a = clienteFalso([respostaFinal("ok")]);
  await new AtendenteClaude("x", () => t, a.cliente).responder([{ autor: "cliente", texto: "SIM" }], SERVICOS_COM_ID, SALAO, { propostaPendente: "Banho de Lua, 2026-11-10 às 09:00 com Bruna" });
  assertStringIncludes((a.pedidos[0].system as Array<{ text: string }>)[1].text, "Banho de Lua, 2026-11-10 às 09:00 com Bruna");
});

Deno.test("prompt traz a equipe", () => {
  assertStringIncludes(montarSistema(SALAO, SERVICOS_TESTE), "Equipe: Alessandra faz manicure e pedicure");
});

Deno.test("modelo e esforço escolhidos no painel vão para a API; sem escolha, o padrão", async () => {
  const a = clienteFalso([respostaFinal("ok"), respostaFinal("ok")]);
  const atendente = new AtendenteClaude("x", () => new Date("2026-11-07T12:00:00Z"), a.cliente);
  const hist = [{ autor: "cliente" as const, texto: "oi" }];
  await atendente.responder(hist, SERVICOS_COM_ID, SALAO, { modelo: "claude-opus-5-5", esforco: "high" });
  await atendente.responder(hist, SERVICOS_COM_ID, SALAO);
  assertEquals([a.pedidos[0].model, (a.pedidos[0].output_config as { effort: string }).effort], ["claude-opus-5-5", "high"]);
  assertEquals([a.pedidos[1].model, (a.pedidos[1].output_config as { effort: string }).effort], ["claude-sonnet-5-5", "medium"]);
});

Deno.test("esgotou as rodadas de ferramenta: última chamada sem ferramentas e a IA responde (não dá erro)", async () => {
  const usoFerramenta = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "consultar_horarios", input: { servico_id: 5732343, data: "2026-11-10" } }] };
  const a = clienteFalso([...Array(8).fill(usoFerramenta), respostaFinal("Qual serviço e qual dia você prefere?")]);
  const atendente = new AtendenteClaude("x", () => new Date("2026-11-07T12:00:00Z"), a.cliente);
  const chamadas: string[] = [];
  const ferramentas = { definicoes: [DEF_CONSULTAR], executar: (n: string) => (chamadas.push(n), Promise.resolve("sem horários")) };
  const d = await atendente.responder([{ autor: "cliente", texto: "agenda a progressiva" }], SERVICOS_COM_ID, SALAO, { ferramentas });
  assertEquals(d.resposta, "Qual serviço e qual dia você prefere?");
  assertEquals(chamadas.length, 8);
  assertEquals(a.pedidos.length, 9);
  assertEquals(a.pedidos[0].tool_choice, undefined);
  assertEquals(a.pedidos[8].tool_choice, { type: "none" });
  // o aviso de limite vai junto dos resultados da penúltima rodada
  const ultimaMsg = (a.pedidos[8].messages as Array<{ content: Array<{ type: string; text?: string }> }>).at(-1)!;
  assertStringIncludes(ultimaMsg.content.at(-1)!.text ?? "", "Limite de consultas atingido");
});

Deno.test("prompt: a IA não agenda; quem agenda é o sistema com o comprovante do Pix", () => {
  const s = montarSistema(SALAO, SERVICOS_TESTE);
  assertStringIncludes(s, "sinal de 20%");
  assertStringIncludes(s, "Quem agenda é o sistema");
  assertEquals(s.includes("confirmar_agendamento"), false);
});
