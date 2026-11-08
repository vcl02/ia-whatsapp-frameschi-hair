import { assertEquals } from "jsr:@std/assert@1.0.13";
import { dentroDaJanela, enviarModelo, enviarTexto, lerEventos } from "../functions/_shared/whatsapp.ts";

const PNID = "111";

function payload(value: unknown, phoneNumberId = PNID, field = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, ...value as object } }] }],
  };
}

Deno.test("lê mensagem de texto com nome do perfil", () => {
  const ev = lerEventos(payload({
    contacts: [{ wa_id: "5511999990000", profile: { name: "Ana" } }],
    messages: [{ id: "wamid.1", from: "5511999990000", timestamp: "1730000000", type: "text", text: { body: "Oi" } }],
  }), PNID);
  assertEquals(ev.mensagens.length, 1);
  assertEquals(ev.mensagens[0].texto, "Oi");
  assertEquals(ev.mensagens[0].nomePerfil, "Ana");
  assertEquals(ev.mensagens[0].recebidaEm.toISOString(), new Date(1730000000 * 1000).toISOString());
});

Deno.test("mídia vira mensagem sem texto", () => {
  const ev = lerEventos(payload({
    messages: [{ id: "wamid.2", from: "55", timestamp: "1", type: "audio", audio: { id: "x" } }],
  }), PNID);
  assertEquals(ev.mensagens[0].tipo, "audio");
  assertEquals(ev.mensagens[0].texto, null);
});

Deno.test("lê status com erro", () => {
  const ev = lerEventos(payload({
    statuses: [{ id: "wamid.3", status: "failed", timestamp: "1730000000", recipient_id: "55", errors: [{ code: 12345, title: "t" }] }],
  }), PNID);
  assertEquals(ev.statuses.length, 1);
  assertEquals(ev.statuses[0].status, "failed");
  assertEquals((ev.statuses[0].erros as { code: number }[])[0].code, 12345);
});

Deno.test("ignora outro número e outros campos", () => {
  assertEquals(lerEventos(payload({ messages: [{ id: "a", from: "b", type: "text" }] }, "999"), PNID).ignorados, 1);
  assertEquals(lerEventos(payload({}, PNID, "account_update"), PNID).ignorados, 1);
  assertEquals(lerEventos(null, PNID).mensagens.length, 0);
});

Deno.test("janela de 24 h", () => {
  const agora = new Date("2026-11-05T12:00:00Z");
  assertEquals(dentroDaJanela(new Date("2026-11-04T12:00:01Z"), agora), true);
  assertEquals(dentroDaJanela(new Date("2026-11-04T11:59:59Z"), agora), false);
  assertEquals(dentroDaJanela(null, agora), false);
});

Deno.test("envio: monta a requisição e lê o wamid", async () => {
  let pedido: Request | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    pedido = new Request(url, init);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
  }) as typeof fetch;
  const r = await enviarTexto({ token: "T", phoneNumberId: PNID, graphApiVersion: "vX" }, "55", "olá", fakeFetch);
  assertEquals(r.ok, true);
  assertEquals(r.wamid, "wamid.out");
  assertEquals(pedido!.url, "https://graph.facebook.com/vX/111/messages");
  assertEquals(pedido!.headers.get("authorization"), "Bearer T");
  const body = await pedido!.json();
  assertEquals(body.to, "55");
  assertEquals(body.text.body, "olá");
});

Deno.test("envio: erro da API vira ok=false", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ error: { code: 1 } }), { status: 400 })) as typeof fetch;
  const r = await enviarTexto({ token: "T", phoneNumberId: PNID, graphApiVersion: "vX" }, "55", "x", fakeFetch);
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 400);
});

Deno.test("lê eco de mensagem enviada pelo app do celular", () => {
  const ev = lerEventos(payload({
    message_echoes: [{ id: "wamid.e", from: "55BIZ", to: "5511", timestamp: "1730000000", type: "text", text: { body: "oi, é a Bruna" } }],
  }, PNID, "smb_message_echoes"), PNID);
  assertEquals(ev.ecos.length, 1);
  assertEquals(ev.ecos[0].para, "5511");
  assertEquals(ev.ecos[0].texto, "oi, é a Bruna");
  assertEquals(ev.ignorados, 0);
});

Deno.test("envio de modelo com parâmetros no corpo", async () => {
  let body: Record<string, any> = {};
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ messages: [{ id: "w" }] }), { status: 200 });
  }) as typeof fetch;
  const r = await enviarModelo({ token: "T", phoneNumberId: PNID, graphApiVersion: "vX" }, "55", "aviso", "pt_BR", ["a", "b"], fakeFetch);
  assertEquals(r.ok, true);
  assertEquals(body.type, "template");
  assertEquals(body.template.name, "aviso");
  assertEquals(body.template.language.code, "pt_BR");
  assertEquals(body.template.components[0].parameters.map((p: { text: string }) => p.text), ["a", "b"]);
});

const listas = (teste: string[], familiar: string[]) => ({ teste: new Set(teste), familiar: new Set(familiar) });

Deno.test("normalizar número: só dígitos e 55 quando faltar", async () => {
  const { normalizarNumero } = await import("../functions/_shared/whatsapp.ts");
  assertEquals(normalizarNumero("(11) 99209-0474"), "5511992090474");
  assertEquals(normalizarNumero("+55 11 99209-0474"), "5511992090474");
  assertEquals(normalizarNumero("1133334444"), "551133334444");
});

Deno.test("quem a IA atende: lista de teste manda; vazia, vale todos menos familiares", async () => {
  const { atendeNumero } = await import("../functions/_shared/whatsapp.ts");
  // Sem listas: todo mundo.
  assertEquals(atendeNumero(listas([], []), "5511000000000"), true);
  // Só familiares: todos, menos eles.
  assertEquals(atendeNumero(listas([], ["5511111111111"]), "5511111111111"), false);
  assertEquals(atendeNumero(listas([], ["5511111111111"]), "5511222222222"), true);
  // Com lista de teste: só quem está nela...
  assertEquals(atendeNumero(listas(["5511992090474"], ["5511111111111"]), "5511992090474"), true);
  assertEquals(atendeNumero(listas(["5511992090474"], ["5511111111111"]), "5511222222222"), false);
  // ...e ela passa por cima de familiares.
  assertEquals(atendeNumero(listas(["5511111111111"], ["5511111111111"]), "5511111111111"), true);
});

Deno.test("filtro por listas: o que a IA não atende não passa (mensagem, eco, status)", async () => {
  const { filtrarPorListas } = await import("../functions/_shared/whatsapp.ts");
  const ev = lerEventos({
    entry: [{ changes: [
      { field: "messages", value: { metadata: { phone_number_id: PNID },
        messages: [
          { id: "w1", from: "5511992090474", timestamp: "1", type: "text", text: { body: "teste" } },
          { id: "w2", from: "5511888887777", timestamp: "1", type: "text", text: { body: "msg pessoal" } },
        ],
        statuses: [
          { id: "s1", status: "delivered", timestamp: "1", recipient_id: "5511992090474" },
          { id: "s2", status: "delivered", timestamp: "1", recipient_id: "5511888887777" },
        ] } },
      { field: "smb_message_echoes", value: { metadata: { phone_number_id: PNID },
        message_echoes: [{ id: "e1", to: "5511888887777", timestamp: "1", type: "text", text: { body: "resposta pessoal" } }] } },
    ] }],
  }, PNID);
  const { eventos, descartados } = filtrarPorListas(ev, listas(["5511992090474"], []));
  assertEquals(eventos.mensagens.map((m) => m.wamid), ["w1"]);
  assertEquals(eventos.statuses.map((s) => s.wamid), ["s1"]);
  assertEquals(eventos.ecos.length, 0);
  assertEquals(descartados, 3);
  // Sem listas (produção aberta): mantém tudo.
  assertEquals(filtrarPorListas(ev, listas([], [])).descartados, 0);
  // Só familiares: some só o familiar.
  assertEquals(filtrarPorListas(ev, listas([], ["5511888887777"])).eventos.mensagens.map((m) => m.wamid), ["w1"]);
});

Deno.test("reação a mensagem é ignorada (não grava nem chama humano); emoji digitado é texto", () => {
  const ev = lerEventos(payload({
    messages: [
      { id: "wamid.r", from: "55", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } },
      { id: "wamid.t", from: "55", timestamp: "2", type: "text", text: { body: "👍" } },
    ],
  }), PNID);
  assertEquals(ev.mensagens.map((m) => m.texto), ["👍"]);
  assertEquals(ev.ignorados, 1);
});
