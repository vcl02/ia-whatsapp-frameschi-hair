import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import {
  enviarLembretes, expiracaoDevida, INTERVALO_LEMBRETE_MS, lembreteDevido, MAX_LEMBRETES, textoExpiracao, textoLembrete,
  type PropostaParaLembrete, type RepositorioLembretes,
} from "../functions/_shared/lembrete.ts";

const T0 = new Date("2026-11-08T19:00:00Z").getTime();
const MIN = 60_000;

function proposta(p: Partial<PropostaParaLembrete> = {}): PropostaParaLembrete {
  return {
    id: "p1", conversaId: "c1", waId: "5511992090474", botPausado: false, nomeCliente: "Isa",
    servicoNome: "Hidratação", data: "2026-11-11", hora: "09:00", preco: "R$ 20,00",
    criadoEm: T0, expiraEm: T0 + 30 * MIN, lembretes: 0, ...p,
  };
}

Deno.test("lembretes aos 7, 14, 21 e 28 minutos, nunca antes", () => {
  const p = proposta();
  assertEquals(lembreteDevido(p, T0 + 6 * MIN), false);
  assertEquals(lembreteDevido(p, T0 + 7 * MIN), true);
  assertEquals(lembreteDevido({ ...p, lembretes: 1 }, T0 + 13 * MIN), false);
  assertEquals(lembreteDevido({ ...p, lembretes: 1 }, T0 + 14 * MIN), true);
  assertEquals(lembreteDevido({ ...p, lembretes: 3 }, T0 + 28 * MIN), true);
  assertEquals(INTERVALO_LEMBRETE_MS, 7 * MIN);
});

Deno.test("sem lembrete: IA pausada, limite de 4, reserva vencida", () => {
  assertEquals(lembreteDevido(proposta({ botPausado: true }), T0 + 8 * MIN), false);
  assertEquals(lembreteDevido(proposta({ lembretes: MAX_LEMBRETES }), T0 + 29 * MIN), false);
  assertEquals(lembreteDevido(proposta(), T0 + 31 * MIN), false);
});

Deno.test("texto: horário, sinal de 20%, comprovante e minutos que restam; o último avisa", () => {
  const t = textoLembrete(proposta(), T0 + 7 * MIN);
  assertStringIncludes(t, "quarta-feira, 11/11");
  assertStringIncludes(t, "R$ 4,00");
  assertStringIncludes(t, "comprovante");
  assertStringIncludes(t, "23 minutos");
  assertStringIncludes(textoLembrete(proposta({ lembretes: 3 }), T0 + 28 * MIN), "Última lembrança");
  assertEquals(textoLembrete(proposta(), T0 + 7 * MIN).includes("\n"), false);
});

function cenario(itens: PropostaParaLembrete[], reservaOk = true) {
  const enviados: Array<[string, string]> = [];
  const registrados: string[] = [];
  const reservas: Array<[string, number, boolean]> = [];
  const repo: RepositorioLembretes = {
    listar: () => Promise.resolve(itens),
    reservar: (id, atual, expirar = false) => (reservas.push([id, atual, expirar]), Promise.resolve(reservaOk)),
  };
  return {
    enviados, registrados, reservas,
    rodar: (agora: number) => enviarLembretes({
      repo,
      enviar: (para, texto) => (enviados.push([para, texto]), Promise.resolve({ ok: true, wamid: "w", httpStatus: 200, erro: null })),
      registrarSaida: (_c, texto) => (registrados.push(texto), Promise.resolve()),
      log: () => {},
      agora: () => agora,
    }),
  };
}

Deno.test("envia só os vencidos, reserva antes e registra a mensagem", async () => {
  const c = cenario([proposta({ id: "a" }), proposta({ id: "b", criadoEm: T0 + 5 * MIN, expiraEm: T0 + 35 * MIN })]);
  assertEquals(await c.rodar(T0 + 7 * MIN), 1);
  assertEquals(c.reservas, [["a", 0, false]]);
  assertEquals(c.enviados.length, 1);
  assertEquals(c.enviados[0][0], "5511992090474");
  assertEquals(c.registrados.length, 1);
});

Deno.test("outra execução já pegou o lembrete: não envia de novo", async () => {
  const c = cenario([proposta()], false);
  assertEquals(await c.rodar(T0 + 7 * MIN), 0);
  assertEquals(c.enviados.length, 0);
});

Deno.test("chamadas repetidas no mesmo minuto não duplicam (a reserva barra)", async () => {
  const itens = [proposta()];
  let contador = 0;
  const enviados: string[] = [];
  const repo: RepositorioLembretes = {
    listar: () => Promise.resolve(itens.map((i) => ({ ...i, lembretes: contador }))),
    reservar: (_id, atual) => { if (atual !== contador) return Promise.resolve(false); contador++; return Promise.resolve(true); },
  };
  const deps = { repo, enviar: (_p: string, t: string) => (enviados.push(t), Promise.resolve({ ok: true, wamid: "w", httpStatus: 200, erro: null })), registrarSaida: () => Promise.resolve(), log: () => {}, agora: () => T0 + 7 * MIN };
  await enviarLembretes(deps);
  await enviarLembretes(deps);
  assertEquals(enviados.length, 1);
});

Deno.test("reserva vencida sem comprovante: avisa uma vez que o horário não foi agendado", async () => {
  const p = proposta({ lembretes: 4 });
  assertEquals(lembreteDevido(p, T0 + 31 * MIN), false);
  assertEquals(expiracaoDevida(p, T0 + 29 * MIN), false);
  assertEquals(expiracaoDevida(p, T0 + 30 * MIN), true);
  assertEquals(expiracaoDevida({ ...p, botPausado: true }, T0 + 31 * MIN), false);
  const t = textoExpiracao(p);
  assertStringIncludes(t, "não foi agendado");
  assertStringIncludes(t, "quarta-feira, 11/11");
  assertEquals(t.includes("\n"), false);
  const c = cenario([p]);
  assertEquals(await c.rodar(T0 + 31 * MIN), 1);
  assertEquals(c.reservas, [["p1", 4, true]]);
  assertStringIncludes(c.enviados[0][1], "não foi agendado");
});

Deno.test("vencida e com lembretes que não saíram: manda só o aviso de expiração", async () => {
  const c = cenario([proposta({ lembretes: 1 })]);
  assertEquals(await c.rodar(T0 + 32 * MIN), 1);
  assertEquals(c.reservas, [["p1", 1, true]]);
});
