// Aviso à equipe por e-mail quando uma conversa precisa de alguém.
// Provedor: Resend (API HTTP simples). Trocar de provedor = trocar só
// `enviarEmailResend`. Sem configuração, o aviso é só registrado no log.
// O e-mail leva nome do perfil, número e motivo; nunca o texto da conversa.

import type { Conversa } from "./bot.ts";

export interface ConfigAviso {
  para: string[]; // e-mails da equipe
  de: string | null; // remetente aceito pelo provedor
  apiKey: string | null;
}

export interface Email {
  de: string;
  para: string[];
  assunto: string;
  texto: string;
}

export interface DepsAviso {
  enviarEmail(
    cfg: ConfigAviso,
    email: Email,
  ): Promise<{ ok: boolean; status: number }>;
  log(evento: string, dados?: Record<string, unknown>): void;
}

export function lerConfigAviso(
  env: (n: string) => string | undefined,
): ConfigAviso {
  return {
    para: (env("SALAO_AVISO_EMAIL_PARA") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes("@")),
    de: env("SALAO_AVISO_EMAIL_DE") || null,
    apiKey: env("SALAO_RESEND_API_KEY") || null,
  };
}

export function montarEmail(
  cfg: ConfigAviso,
  c: Conversa,
  motivo: string,
): Email {
  const cliente = c.nomePerfil ? `${c.nomePerfil} (+${c.waId})` : `+${c.waId}`;
  return {
    de: cfg.de!,
    para: cfg.para,
    assunto: `Bruna Frameschi Hair: conversa precisa de você (${c.nomePerfil ?? c.waId})`,
    texto:
      `Uma conversa no WhatsApp do salão precisa de atendimento humano.\n\n` +
      `Cliente: ${cliente}\nMotivo: ${motivo}\n\n` +
      `A IA desta conversa está pausada. Responda pelo app do WhatsApp Business e, quando quiser, clique em "Retomar IA" no painel.`,
  };
}

export async function avisarEquipe(
  cfg: ConfigAviso,
  deps: DepsAviso,
  c: Conversa,
  motivo: string,
): Promise<void> {
  if (!cfg.apiKey || !cfg.de || cfg.para.length === 0) {
    deps.log("aviso_equipe", {
      conversa: c.id,
      via: "nenhum",
      motivo: "e-mail não configurado",
    });
    return;
  }
  const r = await deps.enviarEmail(cfg, montarEmail(cfg, c, motivo));
  deps.log("aviso_equipe", {
    conversa: c.id,
    via: "email",
    ok: r.ok,
    http: r.status,
  });
}

export async function enviarEmailResend(
  cfg: ConfigAviso,
  email: Email,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const resp = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: email.de,
      to: email.para,
      subject: email.assunto,
      text: email.texto,
    }),
  });
  await resp.body?.cancel();
  return { ok: resp.ok, status: resp.status };
}

/** E-mail livre para a equipe (ex.: resumo da sincronização). Sem configuração, só registra no log. */
export async function enviarResumo(
  cfg: ConfigAviso,
  deps: DepsAviso,
  assunto: string,
  texto: string,
): Promise<void> {
  if (!cfg.apiKey || !cfg.de || cfg.para.length === 0) {
    deps.log("resumo_equipe", { via: "nenhum", assunto });
    return;
  }
  const r = await deps.enviarEmail(cfg, {
    de: cfg.de,
    para: cfg.para,
    assunto,
    texto,
  });
  deps.log("resumo_equipe", {
    via: "email",
    ok: r.ok,
    http: r.status,
    assunto,
  });
}
