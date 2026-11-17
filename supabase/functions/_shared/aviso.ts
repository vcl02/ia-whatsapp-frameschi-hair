// Aviso à equipe quando uma conversa precisa de alguém: e-mail (Resend, uma conta por
// pessoa: sem domínio verificado o Resend só entrega ao dono da conta) e modelo aprovado
// no WhatsApp para o celular pessoal da Bruna. Trocar de provedor de e-mail = trocar só
// `enviarEmailResend`. Sem configuração, o aviso é só registrado no log.
// O aviso leva nome do perfil, número e motivo; nunca o texto da conversa.

import type { Conversa } from './bot.ts';
import { normalizarNumero, type ResultadoEnvio } from './whatsapp.ts';

/**
 * Modelo (template) aprovado na Meta para avisar a equipe. Corpo: "Aviso da assistente Lia:
 * a cliente {{1}} (telefone {{2}}) precisa de atendimento humano. Motivo: {{3}}. Responda a
 * ela pelo WhatsApp Business do salão." O cabeçalho é texto fixo, sem variável.
 */
export const MODELO_AVISO_WHATSAPP = 'aviso_atendimento_equipe';
export const IDIOMA_AVISO_WHATSAPP = 'pt_BR';

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
    para: (env('SALAO_AVISO_EMAIL_PARA') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.includes('@')),
    de: env('SALAO_AVISO_EMAIL_DE') || null,
    apiKey: env('SALAO_RESEND_API_KEY') || null,
  };
}

/**
 * Contas de e-mail que recebem os avisos: a principal (SALAO_AVISO_EMAIL_PARA,
 * SALAO_AVISO_EMAIL_DE, SALAO_RESEND_API_KEY) e a da Bruna (os mesmos nomes com o sufixo
 * _BRUNA, com a chave do Resend dela). Só entram as completas, então dá para usar só uma
 * delas. Se nenhuma estiver completa, devolve a principal (o aviso vira só uma linha de log).
 */
export function lerConfigsAviso(
  env: (n: string) => string | undefined,
): ConfigAviso[] {
  const principal = lerConfigAviso(env);
  const completas = [principal, lerConfigAviso((n) => env(`${n}_BRUNA`))].filter(
    (c) => c.apiKey && c.de && c.para.length > 0,
  );
  return completas.length > 0 ? completas : [principal];
}

/** Números que recebem o aviso pelo WhatsApp (SALAO_AVISO_WHATSAPP_PARA, separados por vírgula). */
export function lerNumerosAvisoWhatsapp(
  env: (n: string) => string | undefined,
): string[] {
  return (env('SALAO_AVISO_WHATSAPP_PARA') ?? '')
    .split(',')
    .map(normalizarNumero)
    .filter((n) => n.length >= 12);
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
    texto: `Uma conversa no WhatsApp do salão precisa de atendimento humano.\n\n` +
      `Cliente: ${cliente}\nMotivo: ${motivo}\n\n` +
      `A IA desta conversa está pausada. Responda pelo app do WhatsApp Business e, quando quiser, clique em "Retomar IA" no painel.`,
  };
}

export async function avisarEquipe(
  config: ConfigAviso | ConfigAviso[],
  deps: DepsAviso,
  c: Conversa,
  motivo: string,
): Promise<void> {
  for (const cfg of Array.isArray(config) ? config : [config]) {
    if (!cfg.apiKey || !cfg.de || cfg.para.length === 0) {
      deps.log('aviso_equipe', {
        conversa: c.id,
        via: 'nenhum',
        motivo: 'e-mail não configurado',
      });
      continue;
    }
    try {
      const r = await deps.enviarEmail(cfg, montarEmail(cfg, c, motivo));
      deps.log('aviso_equipe', {
        conversa: c.id,
        via: 'email',
        ok: r.ok,
        http: r.status,
      });
      // Falha do provedor (ex.: 403 do Resend) também vai para o painel de erros.
      if (!r.ok) deps.log('erro_aviso_email', { conversa: c.id, http: r.status });
    } catch (e) {
      deps.log('erro_aviso_email', { conversa: c.id, erro: String(e) });
    }
  }
}

/** Variáveis de modelo do WhatsApp não aceitam quebra de linha nem espaços repetidos. */
function paraVariavel(t: string, max: number): string {
  return t.replace(/\s+/g, ' ').trim().slice(0, max) || '-';
}

/**
 * Avisa a equipe pelo WhatsApp com o modelo aprovado ({{1}} nome, {{2}} telefone, {{3}} motivo).
 * Um número que falha não impede os outros. Nada do texto da conversa vai no aviso.
 */
export async function avisarEquipeWhatsapp(
  numeros: string[],
  enviarModelo: (
    para: string,
    modelo: string,
    idioma: string,
    parametros: string[],
  ) => Promise<ResultadoEnvio>,
  log: (evento: string, dados?: Record<string, unknown>) => void,
  c: Conversa,
  motivo: string,
): Promise<void> {
  if (numeros.length === 0) return;
  const nome = paraVariavel(c.nomePerfil ?? 'sem nome', 80);
  const telefone = paraVariavel(c.waId, 20);
  // O modelo já põe o ponto final depois do motivo.
  const mot = paraVariavel(motivo, 400).replace(/[.\s]+$/, '') || '-';
  for (const numero of numeros) {
    try {
      const r = await enviarModelo(numero, MODELO_AVISO_WHATSAPP, IDIOMA_AVISO_WHATSAPP, [
        nome,
        telefone,
        mot,
      ]);
      log('aviso_equipe', {
        conversa: c.id,
        via: 'whatsapp',
        ok: r.ok,
        http: r.httpStatus,
      });
      if (!r.ok) {
        log('erro_aviso_whatsapp', { conversa: c.id, http: r.httpStatus, erro: r.erro });
      }
    } catch (e) {
      log('erro_aviso_whatsapp', { conversa: c.id, erro: String(e) });
    }
  }
}

export async function enviarEmailResend(
  cfg: ConfigAviso,
  email: Email,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const resp = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
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
  config: ConfigAviso | ConfigAviso[],
  deps: DepsAviso,
  assunto: string,
  texto: string,
): Promise<void> {
  for (const cfg of Array.isArray(config) ? config : [config]) {
    if (!cfg.apiKey || !cfg.de || cfg.para.length === 0) {
      deps.log('resumo_equipe', { via: 'nenhum', assunto });
      continue;
    }
    try {
      const r = await deps.enviarEmail(cfg, {
        de: cfg.de,
        para: cfg.para,
        assunto,
        texto,
      });
      deps.log('resumo_equipe', {
        via: 'email',
        ok: r.ok,
        http: r.status,
        assunto,
      });
      if (!r.ok) deps.log('erro_aviso_email', { http: r.status, assunto });
    } catch (e) {
      deps.log('erro_aviso_email', { erro: String(e), assunto });
    }
  }
}
