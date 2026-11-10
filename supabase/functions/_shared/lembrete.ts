// Lembrete a cada 7 minutos, enquanto a cliente ainda não mandou o comprovante do Pix.
// Roda pela função salao-lembrete (pg_cron, a cada minuto). Os textos são fixos (sem IA).
// A proposta vale 30 min: lembretes aos 7, 14, 21 e 28 minutos, no máximo 4. Quando a
// reserva vence sem comprovante, um último aviso diz que o horário não foi agendado.

import { dataCurta, sinalDoServico } from "./agendamento.ts";
import type { ResultadoEnvio } from "./whatsapp.ts";

export const INTERVALO_LEMBRETE_MS = 7 * 60_000;
export const MAX_LEMBRETES = 4;

export interface PropostaParaLembrete {
  id: string;
  conversaId: string;
  waId: string;
  botPausado: boolean;
  nomeCliente: string;
  servicoNome: string;
  data: string;
  hora: string;
  preco: string | null;
  criadoEm: number; // epoch ms
  expiraEm: number; // epoch ms
  lembretes: number; // quantos já foram enviados
}

export interface RepositorioLembretes {
  /** Propostas com status "proposto" (no prazo ou vencidas há pouco). */
  listar(): Promise<PropostaParaLembrete[]>;
  /**
   * Marca o envio (antes de enviar). `expirar` também muda o status para "expirado".
   * false = outra execução já pegou.
   */
  reservar(id: string, atual: number, expirar?: boolean): Promise<boolean>;
}

/** Já passou a hora do próximo lembrete? Conversa com a IA pausada não recebe. */
export function lembreteDevido(p: PropostaParaLembrete, agora: number): boolean {
  return (
    !p.botPausado &&
    p.lembretes < MAX_LEMBRETES &&
    p.expiraEm > agora &&
    agora >= p.criadoEm + (p.lembretes + 1) * INTERVALO_LEMBRETE_MS
  );
}

/** A reserva venceu sem comprovante e a cliente ainda não foi avisada? */
export function expiracaoDevida(p: PropostaParaLembrete, agora: number): boolean {
  return !p.botPausado && p.expiraEm <= agora;
}

export function textoExpiracao(p: PropostaParaLembrete): string {
  const servico = p.servicoNome.replace(/\s*\(a partir de\)/i, "");
  return `${p.nomeCliente}, o tempo da reserva do horário (${servico}, ${dataCurta(p.data)}, às ${p.hora}) acabou e, como não recebi o comprovante do Pix, ele não foi agendado. 💖 Se ainda quiser, é só me avisar que eu vejo os horários de novo.`;
}

export function textoLembrete(p: PropostaParaLembrete, agora: number): string {
  const minutos = Math.max(1, Math.ceil((p.expiraEm - agora) / 60_000));
  const servico = p.servicoNome.replace(/\s*\(a partir de\)/i, "");
  const horario = `${servico}, ${dataCurta(p.data)}, às ${p.hora}`;
  const sinal = sinalDoServico(p.preco, p.servicoNome)?.texto ?? "o sinal de 20%";
  const nome = p.nomeCliente;
  const textos = [
    `Oi, ${nome}! 💖 Passando só pra lembrar: seu horário (${horario}) só fica agendado depois que eu receber o comprovante do Pix de ${sinal}, em imagem ou PDF. Ele continua reservado pra você por mais ${minutos} minutos.`,
    `${nome}, ainda não recebi o comprovante do Pix de ${sinal}. Sem ele o horário (${horario}) não é agendado. Você consegue me mandar aqui, em imagem ou PDF? A reserva vale por mais ${minutos} minutos.`,
    `Oi, ${nome}! Seu horário (${horario}) ainda está só reservado e falta o comprovante do Pix de ${sinal}. É só enviar aqui, em imagem ou PDF, que eu agendo. Restam ${minutos} minutos de reserva.`,
    `Última lembrança, ${nome}: a reserva do horário (${horario}) termina em ${minutos} minutos e, sem o comprovante do Pix de ${sinal}, ele não será agendado.`,
  ];
  return textos[Math.min(p.lembretes, textos.length - 1)];
}

export interface DepsLembretes {
  repo: RepositorioLembretes;
  enviar(para: string, texto: string): Promise<ResultadoEnvio>;
  registrarSaida(
    conversaId: string,
    texto: string,
    envio: ResultadoEnvio,
  ): Promise<void>;
  log(evento: string, dados?: Record<string, unknown>): void;
  agora?: () => number;
}

/** Envia os lembretes que venceram. Devolve quantos foram enviados. */
export async function enviarLembretes(deps: DepsLembretes): Promise<number> {
  const agora = (deps.agora ?? Date.now)();
  let enviados = 0;
  for (const p of await deps.repo.listar()) {
    const expirou = !lembreteDevido(p, agora) && expiracaoDevida(p, agora);
    if (!expirou && !lembreteDevido(p, agora)) continue;
    if (!(await deps.repo.reservar(p.id, p.lembretes, expirou))) continue;
    try {
      const texto = expirou ? textoExpiracao(p) : textoLembrete(p, agora);
      const envio = await deps.enviar(p.waId, texto);
      await deps.registrarSaida(p.conversaId, texto, envio);
      deps.log(expirou ? "reserva_expirada_aviso" : "lembrete_comprovante", {
        conversa: p.conversaId,
        numero: p.lembretes + 1,
        envio_ok: envio.ok,
      });
      if (envio.ok) enviados++;
    } catch (e) {
      deps.log("erro_lembrete", { conversa: p.conversaId, erro: String(e) });
    }
  }
  return enviados;
}
