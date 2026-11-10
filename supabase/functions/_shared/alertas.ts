// Alerta por e-mail quando há erros novos: no máximo um por hora, só com a contagem
// por tipo (sem texto de cliente). Roda junto da função salao-lembrete (a cada minuto):
// se passou 1 h desde o último alerta e há erro novo em salao_eventos, manda o resumo.

import type { SupabaseClient } from './deps.ts';
import { EVENTO_DE_ERRO } from './eventos.ts';

export const INTERVALO_ALERTA_MS = 60 * 60_000;
export const CHAVE_ULTIMO_ALERTA = 'ultimo_alerta_erros';

export interface EventoErro {
  tipo: string;
  criado_em: string;
}

export interface RepositorioAlertas {
  ultimoAlerta(): Promise<Date | null>;
  errosDesde(desde: Date): Promise<EventoErro[]>;
  gravarAlerta(em: Date): Promise<void>;
}

export interface DepsAlerta {
  repo: RepositorioAlertas;
  enviar(assunto: string, texto: string): Promise<void>;
  log(evento: string, dados?: Record<string, unknown>): void;
  agora?: () => Date;
}

function horaSaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** Texto do e-mail: contagem por tipo, do mais frequente ao menos. */
export function resumoDosErros(eventos: EventoErro[], desde: Date): string {
  const porTipo = new Map<string, number>();
  for (const e of eventos) porTipo.set(e.tipo, (porTipo.get(e.tipo) ?? 0) + 1);
  const linhas = [...porTipo.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tipo, n]) => `- ${tipo}: ${n}`);
  return (
    `A IA do salão registrou ${eventos.length} erro(s) desde ${
      horaSaoPaulo(desde)
    } (horário de Brasília):\n\n` +
    `${linhas.join('\n')}\n\n` +
    `Os detalhes ficam no painel. Este aviso sai no máximo uma vez por hora e não traz texto de conversa.\n`
  );
}

/**
 * Manda o resumo se passou 1 h desde o último alerta e há erro novo. Reserva o horário
 * antes de enviar (chamadas simultâneas não duplicam). Devolve se enviou.
 */
export async function enviarAlertaDeErros(deps: DepsAlerta): Promise<boolean> {
  const agora = (deps.agora ?? (() => new Date()))();
  const ultimo = await deps.repo.ultimoAlerta();
  if (ultimo && agora.getTime() - ultimo.getTime() < INTERVALO_ALERTA_MS) {
    return false;
  }
  // Primeira vez: só a última hora, para não despejar erros antigos.
  const desde = ultimo ?? new Date(agora.getTime() - INTERVALO_ALERTA_MS);
  const erros = await deps.repo.errosDesde(desde);
  if (erros.length === 0) return false;
  await deps.repo.gravarAlerta(agora);
  try {
    await deps.enviar(
      'IA do salão: erros recentes',
      resumoDosErros(erros, desde),
    );
  } catch (e) {
    deps.log('erro_alerta', { erro: String(e) });
    return false;
  }
  deps.log('alerta_erros', { erros: erros.length });
  return true;
}

export class AlertasSupabase implements RepositorioAlertas {
  constructor(private db: SupabaseClient) {}

  async ultimoAlerta(): Promise<Date | null> {
    const { data, error } = await this.db
      .from('salao_info')
      .select('valor')
      .eq('chave', CHAVE_ULTIMO_ALERTA)
      .maybeSingle();
    if (error) throw error;
    const t = data?.valor ? new Date(data.valor) : null;
    return t && !Number.isNaN(t.getTime()) ? t : null;
  }

  async errosDesde(desde: Date): Promise<EventoErro[]> {
    const { data, error } = await this.db
      .from('salao_eventos')
      .select('tipo, criado_em')
      .gt('criado_em', desde.toISOString())
      .limit(1000);
    if (error) throw error;
    return (data as EventoErro[]).filter((e) => EVENTO_DE_ERRO.test(e.tipo));
  }

  async gravarAlerta(em: Date): Promise<void> {
    const { error } = await this.db.from('salao_info').upsert({
      chave: CHAVE_ULTIMO_ALERTA,
      valor: em.toISOString(),
      atualizado_em: new Date().toISOString(),
    });
    if (error) throw error;
  }
}
