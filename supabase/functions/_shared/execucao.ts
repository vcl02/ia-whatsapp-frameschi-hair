// Execução de um pedido de cancelamento/remarcação DEPOIS que a Bruna aprova no painel do
// salão (função salao-executar-pedido). A IA nunca chega aqui: ela só registra o pedido.
// Antes de mexer na agenda, confere de novo: o agendamento é da cliente do pedido e, na
// remarcação, o novo horário está livre com a profissional. Qualquer dúvida = não faz nada.

import { dataCurta } from './agendamento.ts';
import {
  mesmoTelefone,
  type PainelMinhaAgenda,
  telefonesDoAgendamento,
} from './painel_minhaagenda.ts';
import { dentroDaJanela, type ResultadoEnvio } from './whatsapp.ts';

export interface PedidoParaExecutar {
  id: string;
  conversaId: string;
  waId: string;
  tipo: string;
  agendamentoSistemaId: number | null;
  agendamentoId: string | null; // registro do bot em salao_agendamentos, se houver
  novoData: string | null;
  novoHora: string | null;
  novoProfissional: string | null;
  ultimoInbound: Date | null;
}

export interface RepositorioExecucao {
  /** Pedido pendente (ou null se não existe, já foi feito ou substituído). */
  carregar(id: string): Promise<PedidoParaExecutar | null>;
  /** Marca como "executando" só se ninguém pegou antes. */
  reservar(id: string): Promise<boolean>;
  concluir(id: string, resultado: string): Promise<void>;
  /** Desfaz a reserva e guarda o motivo da falha (o pedido volta a ficar pendente). */
  liberar(id: string, erro: string): Promise<void>;
  /** Acerta o registro do bot (se o pedido veio de um agendamento feito pela IA). */
  acertarAgendamentoBot(
    agendamentoId: string,
    novo:
      | { data: string; hora: string; profissionalId: number; profissionalNome: string }
      | null,
  ): Promise<void>;
}

export interface DepsExecucao {
  repo: RepositorioExecucao;
  painel: Pick<
    PainelMinhaAgenda,
    'agendamento' | 'cancelar' | 'remarcar' | 'equipe' | 'agendaDoDia'
  >;
  enviar(waId: string, texto: string): Promise<ResultadoEnvio>;
  registrarSaida(conversaId: string, texto: string, envio: ResultadoEnvio): Promise<void>;
  log(evento: string, dados?: Record<string, unknown>): void;
  agora?: () => Date;
}

const minutos = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Dois intervalos [inicio, fim) de um mesmo dia se cruzam? */
export function seCruzam(
  aInicio: string,
  aDuracaoMin: number,
  bInicio: string,
  bFim: string,
): boolean {
  const a0 = minutos(aInicio);
  const a1 = a0 + aDuracaoMin;
  const b0 = minutos(bInicio);
  const b1 = Math.max(minutos(bFim), b0 + 1);
  return a0 < b1 && b0 < a1;
}

export async function executarPedido(
  deps: DepsExecucao,
  pedidoId: string,
): Promise<{ ok: boolean; mensagem: string }> {
  const agora = (deps.agora ?? (() => new Date()))();
  const p = await deps.repo.carregar(pedidoId);
  if (!p) return { ok: false, mensagem: 'Pedido não encontrado ou já resolvido.' };
  if ((p.tipo !== 'cancelar' && p.tipo !== 'remarcar') || !p.agendamentoSistemaId) {
    return {
      ok: false,
      mensagem:
        'Este pedido não dá para fazer automaticamente: faça no Minha Agenda e clique em Feito.',
    };
  }
  if (!(await deps.repo.reservar(p.id))) {
    return { ok: false, mensagem: 'Este pedido já está sendo feito.' };
  }
  let feitoNoSistema = false;
  try {
    const a = await deps.painel.agendamento(p.agendamentoSistemaId);
    if (!mesmoTelefone(p.waId, telefonesDoAgendamento(a))) {
      throw new Error('o agendamento não é do telefone desta conversa');
    }
    const servico = String((a.service as { name?: string } | null)?.name ?? 'serviço');
    const dataAtual = String(a.date);
    const horaAtual = String(a.startTime).slice(0, 5);
    let texto: string;
    let resultado: string;

    if (p.tipo === 'cancelar') {
      await deps.painel.cancelar(p.agendamentoSistemaId, dataAtual);
      feitoNoSistema = true;
      if (p.agendamentoId) await deps.repo.acertarAgendamentoBot(p.agendamentoId, null);
      resultado = `Cancelado no Minha Agenda: ${servico}, ${
        dataCurta(dataAtual)
      }, às ${horaAtual}.`;
      texto = `Oi! A Bruna confirmou o cancelamento do seu horário de ${servico} (${
        dataCurta(dataAtual)
      }, às ${horaAtual}). 💖 Se quiser marcar outro dia, é só me chamar por aqui.`;
    } else {
      if (!p.novoData || !p.novoHora || !p.novoProfissional) {
        throw new Error('o pedido não tem o novo dia, horário e profissional');
      }
      const prof = (await deps.painel.equipe()).find((x) =>
        x.nome.toLowerCase() === p.novoProfissional!.trim().toLowerCase()
      );
      if (!prof) throw new Error(`profissional "${p.novoProfissional}" não encontrada`);
      const duracao = Number(a.duration) || 60;
      const dia = await deps.painel.agendaDoDia(p.novoData, 0); // leitura nova, sem cache
      const conflito = dia.find((x) =>
        x.profissionalId === prof.id && x.id !== a.id &&
        seCruzam(p.novoHora!, duracao, x.inicio, x.fim)
      );
      if (conflito) {
        throw new Error(
          `o novo horário (${dataCurta(p.novoData)}, às ${p.novoHora}) já está ocupado`,
        );
      }
      await deps.painel.remarcar(a, {
        data: p.novoData,
        hora: p.novoHora,
        profissionalId: prof.id,
      });
      feitoNoSistema = true;
      if (p.agendamentoId) {
        await deps.repo.acertarAgendamentoBot(p.agendamentoId, {
          data: p.novoData,
          hora: p.novoHora,
          profissionalId: prof.id,
          profissionalNome: prof.nome,
        });
      }
      resultado = `Remarcado no Minha Agenda: ${servico}, de ${
        dataCurta(dataAtual)
      } às ${horaAtual} para ${dataCurta(p.novoData)} às ${p.novoHora} com ${prof.nome}.`;
      texto = `Prontinho! Seu horário de ${servico} foi remarcado para ${
        dataCurta(p.novoData)
      }, às ${p.novoHora}, com a ${prof.nome}. 💖`;
    }

    // Avisa a cliente se ainda estiver na janela de 24 h do WhatsApp.
    if (dentroDaJanela(p.ultimoInbound, agora)) {
      const envio = await deps.enviar(p.waId, texto);
      await deps.registrarSaida(p.conversaId, texto, envio);
      resultado += envio.ok
        ? ' A cliente foi avisada pelo WhatsApp.'
        : ' NÃO consegui avisar a cliente pelo WhatsApp: avise pelo app.';
    } else {
      resultado +=
        ' A cliente NÃO foi avisada (passou da janela de 24 h do WhatsApp): avise pelo app.';
    }
    await deps.repo.concluir(p.id, resultado);
    deps.log('pedido_executado', { pedido: p.id, tipo: p.tipo });
    return { ok: true, mensagem: resultado };
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    if (feitoNoSistema) {
      // A agenda já mudou: o pedido está feito, só o passo seguinte falhou.
      const r =
        `Feito no Minha Agenda, mas houve um problema depois: ${motivo}. Avise a cliente pelo app.`;
      await deps.repo.concluir(p.id, r);
      deps.log('erro_execucao_pedido', { pedido: p.id, erro: motivo, feito: true });
      return { ok: true, mensagem: r };
    }
    await deps.repo.liberar(p.id, motivo);
    deps.log('erro_execucao_pedido', { pedido: p.id, erro: motivo });
    return {
      ok: false,
      mensagem:
        `Não fiz nada no Minha Agenda: ${motivo}. Confira e, se precisar, faça à mão.`,
    };
  }
}
