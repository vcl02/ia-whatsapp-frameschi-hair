// Fecha sozinho os pedidos de cancelamento/remarcação que a Bruna resolveu direto no
// Minha Agenda (sem clicar em "Já fiz à mão"). Roda dentro da salao-lembrete, que o
// pg_cron chama a cada minuto; só lê a agenda (com o cache de 15 min do painel) e só
// quando existe pedido pendente. Dúvida ou erro de leitura: não fecha.

import { dataCurta } from './agendamento.ts';
import { hojeSaoPaulo } from './disponibilidade.ts';
import type { AgendamentoPainel } from './painel_minhaagenda.ts';

export interface PedidoPendente {
  id: string;
  tipo: string;
  agendamentoSistemaId: number;
  data: string; // dia do agendamento quando o pedido foi feito
  hora: string | null;
  novoData: string | null;
  novoHora: string | null;
}

export interface RepositorioFechamento {
  pendentes(): Promise<PedidoPendente[]>;
  fechar(id: string, resultado: string): Promise<void>;
}

export interface DepsFechamento {
  repo: RepositorioFechamento;
  agendaDoDia(data: string): Promise<AgendamentoPainel[]>;
  log(evento: string, dados?: Record<string, unknown>): void;
  agora?: () => Date;
}

/** Decide o que dizer sobre um pedido, ou null se ele ainda está pendente de verdade. */
async function conferir(
  p: PedidoPendente,
  deps: DepsFechamento,
  hoje: string,
): Promise<string | null> {
  if (p.data < hoje) return 'o horário já passou';
  const noDia = (await deps.agendaDoDia(p.data)).find((a) =>
    a.id === p.agendamentoSistemaId
  );
  if (noDia) {
    // Mesmo agendamento, mas a hora mudou: a Bruna remarcou por lá no mesmo dia.
    if (p.hora && noDia.inicio !== p.hora) {
      return `o agendamento foi remarcado no Minha Agenda para ${noDia.inicio} no mesmo dia`;
    }
    return null;
  }
  if (p.tipo === 'remarcar' && p.novoData) {
    const novo = (await deps.agendaDoDia(p.novoData)).find((a) =>
      a.id === p.agendamentoSistemaId
    );
    if (novo) {
      return `o agendamento foi remarcado no Minha Agenda para ${
        dataCurta(novo.data)
      }, às ${novo.inicio}`;
    }
  }
  return p.tipo === 'cancelar'
    ? 'o agendamento foi cancelado no Minha Agenda'
    : 'o agendamento não está mais no horário antigo (remarcado ou cancelado no Minha Agenda)';
}

/** Devolve quantos pedidos foram fechados. */
export async function fecharPedidosResolvidos(deps: DepsFechamento): Promise<number> {
  const pendentes = await deps.repo.pendentes();
  if (pendentes.length === 0) return 0;
  const hoje = hojeSaoPaulo((deps.agora ?? (() => new Date()))());
  let fechados = 0;
  for (const p of pendentes) {
    try {
      const motivo = await conferir(p, deps, hoje);
      if (!motivo) continue;
      await deps.repo.fechar(p.id, `Fechado sozinho: ${motivo}.`);
      deps.log('pedido_fechado_sozinho', { pedido: p.id });
      fechados++;
    } catch (e) {
      deps.log('erro_fechar_pedido', { pedido: p.id, erro: String(e) });
    }
  }
  return fechados;
}
