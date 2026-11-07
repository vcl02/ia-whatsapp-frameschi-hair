// Leitura do payload do webhook e envio pela WhatsApp Cloud API.
// O formato segue a documentação pública da Meta; campos ausentes são
// tratados como opcionais para o parser não quebrar com eventos novos.

export interface MensagemRecebida {
  wamid: string;
  waId: string;
  nomePerfil: string | null;
  tipo: string;
  texto: string | null;
  recebidaEm: Date;
}

export interface StatusRecebido {
  wamid: string;
  status: string;
  recipientId: string | null;
  ocorridoEm: Date | null;
  erros: unknown[] | null;
  conversation: unknown | null;
  pricing: unknown | null;
}

/** Mensagem enviada pelo app WhatsApp Business do celular (coexistência). */
export interface EcoEnviado {
  wamid: string;
  para: string;
  tipo: string;
  texto: string | null;
  enviadaEm: Date;
}

export interface EventosWebhook {
  mensagens: MensagemRecebida[];
  statuses: StatusRecebido[];
  ecos: EcoEnviado[];
  ignorados: number; // eventos de outro número ou de campo desconhecido
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function dataUnix(v: unknown): Date | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

function textoDaMensagem(m: Obj): string | null {
  switch (m.type) {
    case "text":
      return str(obj(m.text).body);
    case "button":
      return str(obj(m.button).text);
    case "interactive": {
      const i = obj(m.interactive);
      return str(obj(i.button_reply).title) ?? str(obj(i.list_reply).title);
    }
    default:
      return null; // mídia, localização etc.: não guardamos conteúdo
  }
}

export function lerEventos(
  payload: unknown,
  phoneNumberId: string,
): EventosWebhook {
  const out: EventosWebhook = {
    mensagens: [],
    statuses: [],
    ecos: [],
    ignorados: 0,
  };
  for (const entry of arr(obj(payload).entry)) {
    for (const change of arr(obj(entry).changes)) {
      const c = obj(change);
      const value = obj(c.value);
      const destino = str(obj(value.metadata).phone_number_id);
      if (destino !== phoneNumberId) {
        out.ignorados++;
        continue;
      }
      // Coexistência: o formato abaixo segue a documentação da Meta como a
      // conheço, mas NÃO foi conferido com um evento real.
      if (c.field === "smb_message_echoes") {
        for (const eco of arr(value.message_echoes)) {
          const e = obj(eco);
          const wamid = str(e.id);
          const para = str(e.to);
          if (!wamid || !para) continue;
          out.ecos.push({
            wamid,
            para,
            tipo: str(e.type) ?? "desconhecido",
            texto: textoDaMensagem(e),
            enviadaEm: dataUnix(e.timestamp) ?? new Date(),
          });
        }
        continue;
      }
      if (c.field !== "messages") {
        out.ignorados++;
        continue;
      }
      const nomes = new Map<string, string>();
      for (const contato of arr(value.contacts)) {
        const ct = obj(contato);
        const waId = str(ct.wa_id);
        const nome = str(obj(ct.profile).name);
        if (waId && nome) nomes.set(waId, nome);
      }
      for (const mensagem of arr(value.messages)) {
        const m = obj(mensagem);
        const wamid = str(m.id);
        const waId = str(m.from);
        if (!wamid || !waId) continue;
        out.mensagens.push({
          wamid,
          waId,
          nomePerfil: nomes.get(waId) ?? null,
          tipo: str(m.type) ?? "desconhecido",
          texto: textoDaMensagem(m),
          recebidaEm: dataUnix(m.timestamp) ?? new Date(),
        });
      }
      for (const status of arr(value.statuses)) {
        const s = obj(status);
        const wamid = str(s.id);
        const st = str(s.status);
        if (!wamid || !st) continue;
        out.statuses.push({
          wamid,
          status: st,
          recipientId: str(s.recipient_id),
          ocorridoEm: dataUnix(s.timestamp),
          erros: Array.isArray(s.errors) ? s.errors : null,
          conversation: s.conversation ?? null,
          pricing: s.pricing ?? null,
        });
      }
    }
  }
  return out;
}

export interface ConfigWhatsApp {
  token: string;
  phoneNumberId: string;
  graphApiVersion: string; // ex.: "vXX.0" — conferir a versão atual no painel da Meta
}

export interface ResultadoEnvio {
  ok: boolean;
  wamid: string | null;
  httpStatus: number;
  erro: unknown | null;
}

async function postar(
  cfg: ConfigWhatsApp,
  corpoMsg: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<ResultadoEnvio> {
  const url = `https://graph.facebook.com/${cfg.graphApiVersion}/${cfg.phoneNumberId}/messages`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...corpoMsg,
    }),
  });
  const corpo = obj(await resp.json().catch(() => ({})));
  const wamid = str(obj(arr(corpo.messages)[0]).id);
  // Atenção: 200 aqui só significa "aceito". A entrega real vem nos statuses.
  return {
    ok: resp.ok && !!wamid,
    wamid,
    httpStatus: resp.status,
    erro: corpo.error ?? null,
  };
}

export function enviarTexto(
  cfg: ConfigWhatsApp,
  para: string,
  texto: string,
  fetchFn: typeof fetch = fetch,
): Promise<ResultadoEnvio> {
  return postar(
    cfg,
    { to: para, type: "text", text: { preview_url: false, body: texto } },
    fetchFn,
  );
}

/** Modelo (template) aprovado na Meta, com parâmetros só no corpo. */
export function enviarModelo(
  cfg: ConfigWhatsApp,
  para: string,
  nome: string,
  idioma: string,
  parametros: string[],
  fetchFn: typeof fetch = fetch,
): Promise<ResultadoEnvio> {
  return postar(
    cfg,
    {
      to: para,
      type: "template",
      template: {
        name: nome,
        language: { code: idioma },
        components: parametros.length
          ? [
              {
                type: "body",
                parameters: parametros.map((t) => ({ type: "text", text: t })),
              },
            ]
          : [],
      },
    },
    fetchFn,
  );
}

/**
 * Lista de números que o bot pode responder (fase de testes).
 * Vazia = responde todo mundo.
 */
export function lerPermitidos(valor: string | undefined): Set<string> {
  return new Set(
    (valor ?? "")
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter(Boolean),
  );
}

export function botPodeResponder(
  permitidos: Set<string>,
  waId: string,
): boolean {
  return permitidos.size === 0 || permitidos.has(waId);
}

/**
 * Remove tudo que envolve números fora da lista (mensagens, ecos e statuses).
 * Lista vazia = mantém tudo.
 */
export function filtrarPorPermitidos(
  ev: EventosWebhook,
  permitidos: Set<string>,
): { eventos: EventosWebhook; descartados: number } {
  const ok = (n: string | null) => botPodeResponder(permitidos, n ?? "");
  const eventos: EventosWebhook = {
    mensagens: ev.mensagens.filter((m) => ok(m.waId)),
    statuses: ev.statuses.filter((s) => ok(s.recipientId)),
    ecos: ev.ecos.filter((e) => ok(e.para)),
    ignorados: ev.ignorados,
  };
  const descartados =
    ev.mensagens.length +
    ev.statuses.length +
    ev.ecos.length -
    (eventos.mensagens.length + eventos.statuses.length + eventos.ecos.length);
  return { eventos, descartados };
}

export const JANELA_24H_MS = 24 * 60 * 60 * 1000;

export function dentroDaJanela(
  ultimoInbound: Date | null,
  agora = new Date(),
): boolean {
  return (
    !!ultimoInbound && agora.getTime() - ultimoInbound.getTime() < JANELA_24H_MS
  );
}
