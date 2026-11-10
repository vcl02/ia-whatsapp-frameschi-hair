import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import {
  enviarAlertaDeErros, INTERVALO_ALERTA_MS, resumoDosErros,
  type EventoErro, type RepositorioAlertas,
} from "../functions/_shared/alertas.ts";
import { EVENTO_DE_ERRO } from "../functions/_shared/eventos.ts";

const T0 = new Date("2026-11-09T15:00:00Z");

class RepoFalso implements RepositorioAlertas {
  gravados: Date[] = [];
  desdeConsultado: Date | null = null;
  constructor(public ultimo: Date | null, private erros: EventoErro[]) {}
  ultimoAlerta(): Promise<Date | null> { return Promise.resolve(this.ultimo); }
  errosDesde(d: Date): Promise<EventoErro[]> { this.desdeConsultado = d; return Promise.resolve(this.erros); }
  gravarAlerta(em: Date): Promise<void> { this.gravados.push(em); this.ultimo = em; return Promise.resolve(); }
}
const repo = (ultimo: Date | null, erros: EventoErro[]) => new RepoFalso(ultimo, erros);
const err = (tipo: string): EventoErro => ({ tipo, criado_em: T0.toISOString() });

function deps(r: RepoFalso, falhaEnvio = false) {
  const emails: Array<{ assunto: string; texto: string }> = [];
  const logs: string[] = [];
  return {
    emails, logs,
    d: {
      repo: r,
      enviar: (assunto: string, texto: string) => {
        if (falhaEnvio) return Promise.reject(new Error("resend fora"));
        emails.push({ assunto, texto });
        return Promise.resolve();
      },
      log: (e: string) => { logs.push(e); },
      agora: () => T0,
    },
  };
}

Deno.test("tipos que contam como erro", () => {
  assertEquals(EVENTO_DE_ERRO.test("erro_llm"), true);
  assertEquals(EVENTO_DE_ERRO.test("erro_funcao_lembrete"), true);
  assertEquals(EVENTO_DE_ERRO.test("status_falha"), true);
  assertEquals(EVENTO_DE_ERRO.test("webhook"), false);
});

Deno.test("resumo: contagem por tipo, do mais frequente, sem texto de conversa", () => {
  const t = resumoDosErros([err("erro_llm"), err("erro_llm"), err("erro_aviso"), err("erro_llm")], T0);
  assertStringIncludes(t, "4 erro(s)");
  assertEquals(t.indexOf("erro_llm: 3") < t.indexOf("erro_aviso: 1"), true);
  assertStringIncludes(t, "12:00"); // 15:00 UTC = 12:00 em Brasília
});

Deno.test("há erro novo e passou 1 h: envia e grava o horário", async () => {
  const r = repo(new Date(T0.getTime() - INTERVALO_ALERTA_MS), [err("erro_llm")]);
  const x = deps(r);
  assertEquals(await enviarAlertaDeErros(x.d), true);
  assertEquals(x.emails.length, 1);
  assertEquals(x.emails[0].assunto, "IA do salão: erros recentes");
  assertEquals(r.gravados, [T0]);
  assertEquals(r.desdeConsultado, new Date(T0.getTime() - INTERVALO_ALERTA_MS));
});

Deno.test("menos de 1 h desde o último alerta: não consulta nem envia", async () => {
  const r = repo(new Date(T0.getTime() - 30 * 60_000), [err("erro_llm")]);
  const x = deps(r);
  assertEquals(await enviarAlertaDeErros(x.d), false);
  assertEquals(x.emails.length, 0);
  assertEquals(r.desdeConsultado, null);
});

Deno.test("sem erro novo: não envia e não mexe no horário", async () => {
  const r = repo(null, []);
  const x = deps(r);
  assertEquals(await enviarAlertaDeErros(x.d), false);
  assertEquals(x.emails.length, 0);
  assertEquals(r.gravados.length, 0);
});

Deno.test("primeira vez: olha só a última hora, não os erros antigos", async () => {
  const r = repo(null, [err("erro_llm")]);
  await enviarAlertaDeErros(deps(r).d);
  assertEquals(r.desdeConsultado, new Date(T0.getTime() - INTERVALO_ALERTA_MS));
});

Deno.test("falha no envio: registra erro_alerta e devolve false", async () => {
  const r = repo(null, [err("erro_llm")]);
  const x = deps(r, true);
  assertEquals(await enviarAlertaDeErros(x.d), false);
  assertEquals(x.logs, ["erro_alerta"]);
});
