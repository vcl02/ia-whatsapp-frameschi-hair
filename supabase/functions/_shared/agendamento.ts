// Agendamento pelo bot no Minha Agenda, com sinal de 20% por Pix:
//  1. propor_agendamento: confere a vaga, grava uma PROPOSTA (vale 30 min) e devolve o
//     resumo, o valor do sinal e a chave Pix para a IA mandar à cliente;
//  2. quando chega uma imagem ou PDF (o comprovante) numa conversa com proposta
//     pendente, o CÓDIGO agenda sozinho (receberComprovante). Ninguém lê o comprovante:
//     a Bruna confere o Pix no banco (o aviso por e-mail pede isso).
// A IA não tem ferramenta para agendar; só o código agenda.
//
// O agendamento é feito com um cadastro de convidada no nome e telefone da
// própria cliente (como se ela agendasse pelo site).

import {
  type Agenda,
  agendaEmTexto,
  API,
  cabecalhosApi,
  cadastrarConvidada,
  ConsultaMinhaAgenda,
  hojeSaoPaulo,
  loginAnonimo,
  validarData,
} from './disponibilidade.ts';
import {
  type AgendamentoPainel,
  DIAS_AGENDA_CLIENTE,
  type PainelMinhaAgenda,
  proximasDatas,
} from './painel_minhaagenda.ts';
import { LINK_LOCALIZACAO, type Servico } from './salao.ts';

// ---------- ferramentas que o modelo vê ----------

export interface DefinicaoFerramenta {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/** Conjunto de ferramentas de uma conversa: definições + execução. */
export interface Ferramentas {
  definicoes: DefinicaoFerramenta[];
  executar(nome: string, entrada: Record<string, unknown>): Promise<string>;
}

export const DEF_CONSULTAR: DefinicaoFerramenta = {
  name: 'consultar_horarios',
  description: 'Consulta os horários livres de UM serviço numa data, por profissional. ' +
    'Use quando a cliente perguntar se tem horário/vaga num dia.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      servico_id: {
        type: 'integer',
        description: 'id do serviço, como aparece entre colchetes na lista de serviços',
      },
      data: { type: 'string', description: 'data no formato AAAA-MM-DD' },
    },
    required: ['servico_id', 'data'],
    additionalProperties: false,
  },
};

export const DEF_PROPOR: DefinicaoFerramenta = {
  name: 'propor_agendamento',
  description:
    'Registra uma proposta de agendamento depois que a cliente escolheu serviço, dia, horário e profissional. ' +
    'Confere se a vaga ainda está livre. NÃO agenda: devolve o resumo, o valor do sinal de 20% e a chave Pix para você mandar à cliente pedindo o comprovante.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      servico_id: { type: 'integer', description: 'id do serviço da lista' },
      data: { type: 'string', description: 'AAAA-MM-DD' },
      hora: {
        type: 'string',
        description: 'horário de início, HH:MM, exatamente como veio da consulta',
      },
      profissional: {
        type: 'string',
        description: 'primeiro nome da profissional, como veio da consulta',
      },
      nome_cliente: {
        type: 'string',
        description: 'nome da cliente para a agenda',
      },
    },
    required: ['servico_id', 'data', 'hora', 'profissional', 'nome_cliente'],
    additionalProperties: false,
  },
};

export const DEF_PEDIDO: DefinicaoFerramenta = {
  name: 'cancelar_ou_remarcar_agendamento',
  description:
    'CANCELA ou REMARCA um agendamento da cliente no Minha Agenda. Use SÓ depois que a cliente confirmou com clareza ' +
    '(cancelar: sabendo que o sinal não é devolvido; remarcar: depois de consultar_horarios mostrar o novo horário livre). ' +
    'O sistema confere tudo de novo, faz a alteração e já manda a confirmação à cliente. ' +
    'Se não puder fazer sozinho (menos de 24 h para o horário, limite do dia, horário ocupado), registra o pedido para a Bruna. ' +
    'Campos que não se aplicam vão como texto vazio.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['cancelar', 'remarcar'] },
      agendamento_sistema_id: {
        type: 'integer',
        description:
          'o número que aparece como [agendamento N] na agenda real da cliente, no contexto. 0 se o horário não estiver lá',
      },
      motivo: {
        type: 'string',
        description:
          'por que a cliente quer cancelar/remarcar, resumido (vazio se ela não disse)',
      },
      horario_atual: {
        type: 'string',
        description:
          'o horário que ela tem marcado (serviço, dia, hora), como ela contou. Só preencha se o contexto NÃO mostrar o agendamento ativo; senão, vazio',
      },
      novo_data: {
        type: 'string',
        description: 'remarcar: novo dia, AAAA-MM-DD; cancelar: vazio',
      },
      novo_hora: {
        type: 'string',
        description:
          'remarcar: novo horário HH:MM, como veio da consulta; cancelar: vazio',
      },
      novo_profissional: {
        type: 'string',
        description:
          'remarcar: primeiro nome da profissional, como veio da consulta; cancelar: vazio',
      },
      observacao_para_bruna: {
        type: 'string',
        description:
          'qualquer detalhe útil para a Bruna (só ela lê; a cliente não vê). Vazio se não houver',
      },
    },
    required: [
      'tipo',
      'agendamento_sistema_id',
      'motivo',
      'horario_atual',
      'novo_data',
      'novo_hora',
      'novo_profissional',
      'observacao_para_bruna',
    ],
    additionalProperties: false,
  },
};

// ---------- regras puras ----------

export const PERCENTUAL_SINAL = 0.2;

/** Primeiro valor em reais de um preço em texto ("R$ 1.250,00", "A partir de R$ 60,00"). */
export function valorDoPreco(preco: string | null | undefined): number | null {
  const m = /(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})/.exec(preco ?? '');
  if (!m) return null;
  const v = Number(`${m[1].replace(/\./g, '')}.${m[2]}`);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function reais(v: number): string {
  return `R$ ${
    v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }`;
}

/** Sinal de 20% do serviço. "A partir de" usa o valor mínimo. Sem valor legível: null. */
export function sinalDoServico(
  preco: string | null | undefined,
  nome?: string | null,
): { texto: string; aPartirDe: boolean } | null {
  const v = valorDoPreco(preco);
  if (v === null) return null;
  return {
    texto: reais(Math.round(v * PERCENTUAL_SINAL * 100) / 100),
    aPartirDe: /a partir de/i.test(`${preco ?? ''} ${nome ?? ''}`),
  };
}

/** "2026-11-11" -> "quarta-feira, 11/11" */
export function dataCurta(data: string): string {
  const d = new Date(`${data}T12:00:00Z`);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'UTC',
    weekday: 'long',
  }).format(d);
  const dm = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
  }).format(d);
  return `${dia}, ${dm}`;
}

const maiuscula = (t: string) => t ? t[0].toUpperCase() + t.slice(1) : t;

/** "2026-11-18" -> "(Quarta) 18 de Novembro" */
export function diaPorExtenso(data: string): string {
  const d = new Date(`${data}T12:00:00Z`);
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', ...o }).format(d);
  const semana = maiuscula(fmt({ weekday: 'long' }).split('-')[0]);
  return `(${semana}) ${Number(fmt({ day: 'numeric' }))} de ${
    maiuscula(fmt({ month: 'long' }))
  }`;
}

/**
 * Mensagem que a cliente recebe quando o horário fica marcado (ou remarcado), no modelo
 * que a Bruna usa (passado pelo Victor em 2026-11-17).
 */
export function mensagemConfirmacao(p: {
  nome: string;
  data: string;
  hora: string;
  servico: string;
  preco: number | null;
  profissional: string;
}): string {
  const nome = p.nome.trim().split(/\s+/)[0] || '';
  return [
    `Oi${nome ? ` ${nome}` : ''}, tudo bem?`,
    `Este é um lembrete do seu atendimento, dia ${diaPorExtenso(p.data)} às ${p.hora}.`,
    `Serviço: ${p.servico}`,
    ...(p.preco ? [reais(p.preco)] : []),
    `Profissional: ${p.profissional}`,
    'Em caso de desistência avisar com antecedência.',
    'Tolerância de atraso 10 minutos, após isso não poderei atender, agradeço a compreensão 🤗',
    'Obrigado.❤️',
    '',
    `📍Localização: ${LINK_LOCALIZACAO}`,
  ].join('\n');
}

/** wa_id brasileiro (5511999998888) -> telefone nacional (11999998888). Outros países: null. */
export function telefoneNacional(waId: string): string | null {
  const d = waId.replace(/\D/g, '');
  return d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : null;
}

const HORA_RE = /^\d{2}:\d{2}$/;

// ---------- propostas (persistência) ----------

export interface Proposta {
  id: string;
  conversaId: string;
  servicoId: number;
  servicoNome: string;
  profissionalId: number;
  profissionalNome: string;
  data: string;
  hora: string;
  preco: string | null;
  nomeCliente: string;
  expiraEm: number; // epoch ms
  criadoEm: number; // epoch ms
  /** Id do agendamento que este substituiu (remarcação feita pela IA). */
  remarcadoDe?: string | null;
}

export interface PropostaRecente extends Proposta {
  status: string;
  atualizadoEm: number; // epoch ms
}

export interface RepositorioPropostas {
  /** Proposta mais recente da conversa, de qualquer status. */
  recente(conversaId: string): Promise<PropostaRecente | null>;
  /** Grava a proposta e marca como "substituido" qualquer proposta pendente anterior da conversa. */
  criar(p: Omit<Proposta, 'id' | 'criadoEm'>): Promise<Proposta>;
  /** Proposta com status "proposto" mais recente da conversa, se houver. */
  pendente(conversaId: string): Promise<Proposta | null>;
  /** Troca o status só se o atual for `de` (evita agendar duas vezes). Devolve se trocou. */
  mudarStatus(
    id: string,
    de: string,
    para: string,
    detalhe?: string,
  ): Promise<boolean>;
  /** Quantos agendamentos o bot fez nesta conversa desde `desde`. */
  agendadosDesde(conversaId: string, desde: Date): Promise<number>;
  /** Agendamento mais recente (status "agendado") da conversa com data de `hoje` em diante. */
  agendadoAtivo(conversaId: string, hoje: string): Promise<Proposta | null>;
  /**
   * Marca o agendamento ativo da conversa como "cancelamento pedido" e devolve o resumo
   * dele (ou null se a conversa não tem agendamento ativo).
   */
  marcarCancelamentoPedido(conversaId: string, hoje: string): Promise<string | null>;
}

// ---------- pedidos de cancelamento e remarcação (a Bruna finaliza no Minha Agenda) ----------

export interface NovoPedido {
  conversaId: string;
  agendamentoId: string | null;
  /** Id do agendamento no Minha Agenda (painel). Com ele a Bruna executa com um clique. */
  agendamentoSistemaId?: number | null;
  /** Dia e hora do agendamento no sistema (para fechar o pedido sozinho depois). */
  agendamentoData?: string | null;
  agendamentoHora?: string | null;
  tipo: 'cancelar' | 'remarcar' | 'indefinido';
  horarioAtual: string | null;
  novoData: string | null;
  novoHora: string | null;
  novoProfissional: string | null;
  motivo: string;
  /** Só a Bruna lê (painel): detalhes e alertas da IA. */
  observacao: string;
}

export interface RepositorioPedidos {
  /** Grava o pedido e marca como "substituido" qualquer pedido pendente anterior da conversa. */
  criar(p: NovoPedido): Promise<string>;
  /** Resumo em uma linha do pedido pendente da conversa, se houver. */
  resumoPendente(conversaId: string): Promise<string | null>;
}

const ROTULO_PEDIDO = {
  cancelar: 'Cancelamento',
  remarcar: 'Remarcação',
  indefinido: 'Cancelamento ou remarcação',
} as const;

export function resumoDoPedido(p: NovoPedido): string {
  const novo = p.novoData && p.novoHora
    ? `, para ${dataCurta(p.novoData)} às ${p.novoHora}${
      p.novoProfissional ? ` com ${p.novoProfissional}` : ''
    }`
    : '';
  return `${ROTULO_PEDIDO[p.tipo]}: ${
    p.horarioAtual ?? 'horário não identificado'
  }${novo}`;
}

/**
 * A IA passou a conversa para a Bruna por cancelamento/remarcação: garante que existe um
 * pedido pendente no painel (mesmo que ela não tenha chamado a ferramenta) e devolve o resumo.
 */
export async function garantirPedido(
  pedidos: RepositorioPedidos,
  propostas:
    | Pick<RepositorioPropostas, 'agendadoAtivo' | 'marcarCancelamentoPedido'>
    | undefined,
  conversaId: string,
  motivo: string,
  hoje: string,
): Promise<string> {
  const existente = await pedidos.resumoPendente(conversaId);
  if (existente) return existente;
  const atual = propostas ? await propostas.agendadoAtivo(conversaId, hoje) : null;
  const pedido: NovoPedido = {
    conversaId,
    agendamentoId: atual?.id ?? null,
    tipo: 'indefinido',
    horarioAtual: atual ? resumoDoAgendamento(atual) : null,
    novoData: null,
    novoHora: null,
    novoProfissional: null,
    motivo: motivo.slice(0, 300),
    observacao: 'A IA passou para a Bruna sem detalhar o pedido: confira a conversa.',
  };
  await pedidos.criar(pedido);
  if (atual) await propostas!.marcarCancelamentoPedido(conversaId, hoje);
  return resumoDoPedido(pedido);
}

/** Resumo de um agendamento em uma linha}

/** Resumo de um agendamento em uma linha, para a IA e para a equipe. */
export function resumoDoAgendamento(p: Proposta): string {
  const servico = p.servicoNome.replace(/\s*\(a partir de\)/i, '');
  const sinal = sinalDoServico(p.preco, p.servicoNome)?.texto;
  return `${servico}, ${
    dataCurta(p.data)
  }, às ${p.hora}, com ${p.profissionalNome}, no nome de ${p.nomeCliente}${
    sinal ? `, sinal de ${sinal}` : ''
  }`;
}

// ---------- agendamento no Minha Agenda ----------

export interface PedidoAgendamento {
  nome: string;
  telefone: string; // nacional, só dígitos
  profissionalId: number;
  servicoId: number;
  data: string;
  hora: string;
  comentario: string;
}

export class AgendadorMinhaAgenda {
  constructor(
    private firebaseKey: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Login anônimo novo + cadastro da cliente + POST do agendamento. Lança em erro. */
  async agendar(p: PedidoAgendamento): Promise<void> {
    const sessao = await loginAnonimo(this.firebaseKey, this.fetchFn);
    await cadastrarConvidada(
      sessao.idToken,
      { name: p.nome, phone: p.telefone, countryIso: 'BR' },
      this.fetchFn,
    );
    const r = await this.fetchFn(`${API}/currentUser/appointments`, {
      method: 'POST',
      headers: {
        ...cabecalhosApi(sessao.idToken),
        'content-type': 'application/json',
        origin: 'https://online.maapp.com.br',
      },
      body: JSON.stringify({
        userCpf: null,
        appointmentsDto: [
          {
            employeeId: p.profissionalId,
            comments: p.comentario,
            date: p.data,
            startTime: p.hora,
            serviceIds: [p.servicoId],
          },
        ],
      }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || j.status !== 'CREATED') {
      throw new Error(
        `Minha Agenda não criou o agendamento (HTTP ${r.status}, status ${
          String(j.status ?? '-')
        })`,
      );
    }
  }
}

// ---------- montagem das ferramentas de uma conversa ----------

export interface ContextoConversa {
  conversaId: string;
  waId: string;
  servicos: Servico[];
}

export interface Pix {
  chave: string;
  titular: string;
}

export interface DepsFerramentas {
  consulta: Pick<ConsultaMinhaAgenda, 'vagas'>;
  agendador?: Pick<AgendadorMinhaAgenda, 'agendar'>; // ausente = só consulta
  propostas?: RepositorioPropostas;
  pix?: Pix; // ausente = não propõe agendamento (nada de sinal sem chave Pix)
  pedidos?: RepositorioPedidos; // ausente = a IA não registra pedidos (só passa para a Bruna)
  /** Agenda real (painel): confere se o agendamento do pedido é mesmo desta cliente. */
  painel?: Pick<PainelMinhaAgenda, 'daCliente'>;
  automatico?: ExecucaoAutomatica;
  avisar: (assunto: string, texto: string) => Promise<void>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
  maxDias: number;
  agora?: () => Date;
}

export const VALIDADE_PROPOSTA_MS = 30 * 60_000;
/** Travas do cancelamento/remarcação feitos pela IA (decisão de 2026-11-17, ajustáveis). */
export const ANTECEDENCIA_MINIMA_AUTOMATICA_MS = 24 * 60 * 60_000;
export const MAX_ACOES_AUTOMATICAS_DIA = 2;

/** Quem executa de verdade no Minha Agenda (ausente = a IA só registra o pedido para a Bruna). */
export interface ExecucaoAutomatica {
  fazer(
    pedidoId: string,
    contexto: { waId: string },
  ): Promise<{ ok: boolean; mensagem: string; avisada: boolean }>;
  feitosDesde(conversaId: string, desde: Date): Promise<number>;
}
const MAX_AGENDAMENTOS_DIA = 1;

export function montarFerramentas(
  ctx: ContextoConversa,
  deps: DepsFerramentas,
): Ferramentas {
  const agora = deps.agora ?? (() => new Date());
  const servicoPorId = new Map(
    ctx.servicos.flatMap((s) => s.origem_id ? [[s.origem_id, s] as const] : []),
  );
  const podeAgendar = !!(deps.agendador && deps.propostas);

  async function agendaOuErro(
    servicoId: number,
    data: string,
    semCache = false,
  ): Promise<Agenda | string> {
    if (!servicoPorId.has(servicoId)) {
      return 'serviço não encontrado na lista: confirme com a cliente qual serviço ela quer';
    }
    const erro = validarData(data, deps.maxDias, agora());
    if (erro) return erro;
    try {
      return await deps.consulta.vagas(servicoId, data, semCache);
    } catch (e) {
      deps.log('erro_consulta_horarios', { erro: String(e) });
      return 'não foi possível consultar a agenda agora: mande o link de agendamento para a cliente';
    }
  }

  async function consultar(e: Record<string, unknown>): Promise<string> {
    const r = await agendaOuErro(Number(e.servico_id), String(e.data ?? ''));
    return typeof r === 'string' ? r : agendaEmTexto(r);
  }

  async function propor(e: Record<string, unknown>): Promise<string> {
    const servicoId = Number(e.servico_id);
    const data = String(e.data ?? '');
    const hora = String(e.hora ?? '');
    const nome = String(e.nome_cliente ?? '').trim();
    const prof = String(e.profissional ?? '')
      .trim()
      .toLowerCase();
    if (!HORA_RE.test(hora)) {
      return 'horário inválido: use HH:MM, como veio da consulta';
    }
    if (!nome) {
      return 'falta o nome da cliente: pergunte como ela quer ser chamada na agenda';
    }
    if (!telefoneNacional(ctx.waId)) {
      return 'não consigo agendar para número de fora do Brasil: mande o link de agendamento';
    }
    if (!deps.pix) {
      return 'o sinal por Pix ainda não está configurado: diga que a Bruna vai ajudar e marque passar_para_humano = true';
    }
    const r = await agendaOuErro(servicoId, data, true);
    if (typeof r === 'string') return r;
    const p = r.profissionais.find((x) => x.nome.toLowerCase() === prof);
    if (!p) {
      return `profissional não encontrada para esse serviço nessa data. Opções: ${
        r.profissionais.map((x) => x.nome).join(', ') || 'nenhuma'
      }`;
    }
    if (!p.horarios.includes(hora)) {
      return `esse horário não está mais livre com ${p.nome}. ${agendaEmTexto(r)}`;
    }
    const s = servicoPorId.get(servicoId)!;
    const sinal = sinalDoServico(s.preco, s.nome);
    if (!sinal) {
      return 'não consigo calcular o sinal deste serviço: diga que a Bruna vai combinar o valor e marque passar_para_humano = true';
    }
    const proposta = await deps.propostas!.criar({
      conversaId: ctx.conversaId,
      servicoId,
      servicoNome: s.nome,
      profissionalId: p.id,
      profissionalNome: p.nome,
      data,
      hora,
      preco: s.preco ?? null,
      nomeCliente: nome,
      expiraEm: agora().getTime() + VALIDADE_PROPOSTA_MS,
    });
    deps.log('proposta_criada', {
      conversa: ctx.conversaId,
      proposta: proposta.id,
    });
    return (
      `Proposta registrada (vale 30 minutos): ${s.nome}, ${data} às ${hora} com ${p.nome}` +
      `${s.preco ? `, ${s.preco}` : ''}, no nome de ${nome}. ` +
      `Para confirmar, a cliente paga um sinal de 20% por Pix: ${sinal.texto}` +
      `${
        sinal.aPartirDe
          ? ' (calculado sobre o valor mínimo; a Bruna confirma o valor final)'
          : ''
      }. ` +
      `Chave Pix: ${deps.pix.chave} (titular: ${deps.pix.titular}). ` +
      `Mande à cliente o resumo do horário, o valor do sinal e a chave Pix, e peça o comprovante em imagem ou PDF aqui na conversa. Avise também, com carinho, que o sinal não é devolvido em caso de cancelamento. ` +
      `O sistema agenda sozinho quando o comprovante chegar: você NÃO agenda e NUNCA diz que está agendado nem que o pagamento foi confirmado. Ainda NÃO está agendado.`
    );
  }

  async function pedido(e: Record<string, unknown>): Promise<string> {
    const texto = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const tipo = texto(e.tipo, 20);
    if (tipo !== 'cancelar' && tipo !== 'remarcar') {
      return 'tipo inválido: use cancelar ou remarcar';
    }
    const motivo = texto(e.motivo, 300);
    const horarioInformado = texto(e.horario_atual, 200);
    const data = texto(e.novo_data, 10);
    const hora = texto(e.novo_hora, 5);
    const prof = texto(e.novo_profissional, 60);
    const atual = deps.propostas
      ? await deps.propostas.agendadoAtivo(ctx.conversaId, hojeSaoPaulo(agora()))
      : null;
    // Agendamento da agenda real: tem que ser desta cliente (pelo telefone).
    const idSistema = Number(e.agendamento_sistema_id) || 0;
    let doSistema: AgendamentoPainel | null = null;
    if (idSistema && deps.painel) {
      try {
        const lista = await deps.painel.daCliente(
          ctx.waId,
          proximasDatas(hojeSaoPaulo(agora()), DIAS_AGENDA_CLIENTE),
        );
        doSistema = lista.find((a) => a.id === idSistema) ?? null;
      } catch (err) {
        deps.log('erro_painel_minhaagenda', { erro: String(err) });
      }
      if (!doSistema) {
        return 'esse agendamento_sistema_id não está na agenda desta cliente: use o número entre colchetes da agenda real do contexto, ou 0 se o horário não estiver lá';
      }
    }
    if (!atual && !horarioInformado && !doSistema) {
      return 'não achei o agendamento da cliente: pergunte qual serviço, dia e horário ela tem marcado e registre de novo, preenchendo horario_atual';
    }
    const alertas: string[] = [];
    if (atual) {
      // Horário de Brasília sem horário de verão (UTC-3).
      const inicio = Date.parse(`${atual.data}T${atual.hora}:00-03:00`);
      if (inicio - agora().getTime() < 24 * 60 * 60_000) {
        alertas.push('ATENÇÃO: faltam menos de 24 horas para o horário atual.');
      }
    }
    let novoData: string | null = null;
    let novoHora: string | null = null;
    let novoProf: string | null = null;
    if (tipo === 'remarcar') {
      if (!data || !HORA_RE.test(hora) || !prof) {
        return 'faltam dados do novo horário: dia (AAAA-MM-DD), horário (HH:MM) e profissional, como vieram da consulta';
      }
      const base = atual
        ? {
          servicoId: atual.servicoId,
          data: atual.data,
          hora: atual.hora,
          prof: atual.profissionalId,
        }
        : doSistema?.servicoId
        ? {
          servicoId: doSistema.servicoId,
          data: doSistema.data,
          hora: doSistema.inicio,
          prof: doSistema.profissionalId,
        }
        : null;
      if (base) {
        const r = await agendaOuErro(base.servicoId, data, true);
        if (typeof r === 'string') return r;
        const p = r.profissionais.find((x) =>
          x.nome.toLowerCase() === prof.toLowerCase()
        );
        if (!p) {
          return `profissional não encontrada para esse serviço nessa data. Opções: ${
            r.profissionais.map((x) => x.nome).join(', ') || 'nenhuma'
          }`;
        }
        if (!p.horarios.includes(hora)) {
          return `esse horário não está livre com ${p.nome}. ${agendaEmTexto(r)}`;
        }
        if (data === base.data && hora === base.hora && p.id === base.prof) {
          return 'esse já é o horário agendado: pergunte para qual novo dia e horário ela quer remarcar';
        }
        novoProf = p.nome;
        alertas.push(
          'Novo horário conferido na agenda no momento do pedido: estava livre.',
        );
      } else {
        const erroData = validarData(data, deps.maxDias, agora());
        if (erroData) return erroData;
        novoProf = prof;
        alertas.push(
          'Novo horário NÃO conferido na agenda (serviço do agendamento atual não identificado).',
        );
      }
      novoData = data;
      novoHora = hora;
    }
    if (!deps.pedidos) {
      return 'o registro de pedidos não está disponível: diga que a Bruna vai ajudar, e marque passar_para_humano = true com intencao = remarcar_ou_cancelar';
    }
    let pedidoId: string;
    try {
      pedidoId = await deps.pedidos.criar({
        conversaId: ctx.conversaId,
        agendamentoId: atual?.id ?? null,
        agendamentoSistemaId: doSistema?.id ?? null,
        agendamentoData: doSistema?.data ?? null,
        agendamentoHora: doSistema?.inicio ?? null,
        tipo,
        horarioAtual: doSistema
          ? `${doSistema.servico}, ${
            dataCurta(doSistema.data)
          }, às ${doSistema.inicio}, com ${doSistema.profissionalNome}`
          : atual
          ? resumoDoAgendamento(atual)
          : horarioInformado,
        novoData,
        novoHora,
        novoProfissional: novoProf,
        motivo,
        observacao: [texto(e.observacao_para_bruna, 500), ...alertas].filter(Boolean)
          .join(' | '),
      });
    } catch (err) {
      deps.log('erro_pedido', { conversa: ctx.conversaId, erro: String(err) });
      return 'não consegui registrar o pedido agora: diga que a Bruna vai ajudar, e marque passar_para_humano = true com intencao = remarcar_ou_cancelar';
    }

    // Travas: só executa sozinho com o agendamento da agenda real (já conferido pelo
    // telefone), com antecedência suficiente e dentro do limite diário de ações da IA.
    let motivoSemAutomatico: string | null = null;
    if (!deps.automatico) {
      motivoSemAutomatico = 'execução automática indisponível';
    } else if (!doSistema) {
      motivoSemAutomatico = 'o horário não está na agenda real desta cliente';
    } else if (
      Date.parse(`${doSistema.data}T${doSistema.inicio}:00-03:00`) - agora().getTime() <
        ANTECEDENCIA_MINIMA_AUTOMATICA_MS
    ) {
      motivoSemAutomatico = 'faltam menos de 24 horas para o horário';
    } else if (
      (await deps.automatico.feitosDesde(
        ctx.conversaId,
        new Date(agora().getTime() - 24 * 60 * 60_000),
      )) >= MAX_ACOES_AUTOMATICAS_DIA
    ) {
      motivoSemAutomatico = 'esta conversa já teve mudanças demais hoje';
    }
    if (!motivoSemAutomatico) {
      const r = await deps.automatico!.fazer(pedidoId, { waId: ctx.waId });
      if (r.ok) {
        deps.log('agenda_alterada_pela_ia', { conversa: ctx.conversaId, tipo });
        const feito = tipo === 'cancelar' ? 'CANCELADO' : 'REMARCADO';
        return r.avisada
          ? `${feito} no sistema. A confirmação JÁ foi enviada à cliente em outra mensagem: deixe "resposta" vazia (só responda se ela perguntar algo), passar_para_humano = false.`
          : `${feito} no sistema, mas NÃO consegui enviar a confirmação: diga à cliente, com carinho, que foi ${
            tipo === 'cancelar' ? 'cancelado' : 'remarcado'
          } (${r.mensagem}). passar_para_humano = false.`;
      }
      motivoSemAutomatico = r.mensagem;
    }

    // Não deu para fazer sozinho: o pedido fica no painel para a Bruna.
    if (tipo === 'cancelar' && atual) {
      await deps.propostas!.marcarCancelamentoPedido(
        ctx.conversaId,
        hojeSaoPaulo(agora()),
      ).catch(() => null);
    }
    deps.log('pedido_registrado', { conversa: ctx.conversaId, tipo });
    return `PEDIDO REGISTRADO para a Bruna (${
      tipo === 'cancelar' ? 'cancelamento' : 'remarcação'
    }); não deu para fazer sozinho (${motivoSemAutomatico}). Ainda NÃO foi ${
      tipo === 'cancelar' ? 'cancelado' : 'remarcado'
    }: a Bruna finaliza no sistema e avisa a cliente por aqui. Diga isso com carinho${
      tipo === 'cancelar'
        ? ' e lembre, sem prometer devolução nem crédito, que o sinal de 20% não é devolvido em caso de cancelamento (regra da Bruna)'
        : ' e não diga que já está remarcado'
    }. Marque passar_para_humano = true e intencao = remarcar_ou_cancelar.`;
  }

  const definicoes = [
    DEF_CONSULTAR,
    ...(podeAgendar ? [DEF_PROPOR] : []),
    ...(deps.pedidos ? [DEF_PEDIDO] : []),
  ];
  return {
    definicoes,
    executar(nome, entrada) {
      deps.log('ferramenta', { nome }); // só o nome, sem dados da cliente
      if (nome === 'consultar_horarios') return consultar(entrada);
      if (podeAgendar && nome === 'propor_agendamento') return propor(entrada);
      if (deps.pedidos && nome === 'cancelar_ou_remarcar_agendamento') {
        return pedido(entrada);
      }
      return Promise.resolve(`ferramenta desconhecida: ${nome}`);
    },
  };
}

// ---------- comprovante recebido: quem agenda é o código ----------

export type ResultadoComprovante =
  | { acao: 'responder'; texto: string }
  | { acao: 'humano'; texto: string; motivo: string }
  | { acao: 'ignorar' };

export interface DepsComprovante {
  consulta: Pick<ConsultaMinhaAgenda, 'vagas'>;
  agendador: Pick<AgendadorMinhaAgenda, 'agendar'>;
  propostas: RepositorioPropostas;
  avisar: (assunto: string, texto: string) => Promise<void>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
  agora?: () => Date;
  /** Número da lista de teste: não vale o limite de 1 agendamento por conversa a cada 24 h. */
  semLimiteDiario?: boolean;
}

/**
 * Chegou imagem ou PDF. Com proposta pendente (e dentro do prazo), agenda e avisa a
 * equipe para conferir o Pix. Sem proposta devolve null (o bot segue o caminho normal),
 * exceto logo depois de um agendamento, quando um segundo comprovante é ignorado.
 * Qualquer dúvida (prazo vencido, horário ocupado, erro) chama a equipe: pode ter dinheiro envolvido.
 */
export async function receberComprovante(
  ctx: { conversaId: string; waId: string },
  deps: DepsComprovante,
  tipoMidia: string,
): Promise<ResultadoComprovante | null> {
  const agora = deps.agora ?? (() => new Date());
  const proposta = await deps.propostas.pendente(ctx.conversaId);
  if (!proposta) {
    const desde = new Date(agora().getTime() - 60 * 60_000);
    return (await deps.propostas.agendadosDesde(ctx.conversaId, desde)) > 0
      ? { acao: 'ignorar' }
      : null;
  }
  const servico = proposta.servicoNome.replace(/\s*\(a partir de\)/i, '');
  const resumo =
    `${servico}, ${proposta.data} às ${proposta.hora} com ${proposta.profissionalNome}, no nome de ${proposta.nomeCliente} (+${ctx.waId})`;
  const chamarBruna = (texto: string, motivo: string): ResultadoComprovante => ({
    acao: 'humano',
    texto,
    motivo: `${motivo}: ${resumo}. Confira o Pix e combine com a cliente.`,
  });

  if (proposta.expiraEm < agora().getTime()) {
    await deps.propostas.mudarStatus(proposta.id, 'proposto', 'expirado');
    return chamarBruna(
      'Recebi seu comprovante! 💖 Como o tempo da reserva (30 minutos) já tinha acabado, eu não consigo agendar sozinha, então vou chamar a Bruna para conferir o horário com você.',
      'comprovante recebido depois de a reserva vencer',
    );
  }
  const desde = new Date(agora().getTime() - 24 * 60 * 60_000);
  if (
    !deps.semLimiteDiario &&
    (await deps.propostas.agendadosDesde(ctx.conversaId, desde)) >= MAX_AGENDAMENTOS_DIA
  ) {
    return chamarBruna(
      'Recebi seu comprovante! 💖 Como já existe um agendamento feito por aqui para você nas últimas 24 horas, eu só consigo agendar um por dia, então vou chamar a Bruna para ver esse novo horário com você.',
      'comprovante recebido, mas esta conversa já teve um agendamento hoje',
    );
  }
  if (!(await deps.propostas.mudarStatus(proposta.id, 'proposto', 'agendando'))) {
    return { acao: 'ignorar' }; // outro comprovante já está sendo processado
  }
  try {
    const r = await deps.consulta.vagas(proposta.servicoId, proposta.data, true);
    const livre = r.profissionais
      .find((p) => p.id === proposta.profissionalId)
      ?.horarios.includes(proposta.hora);
    if (!livre) {
      await deps.propostas.mudarStatus(
        proposta.id,
        'agendando',
        'falhou',
        'horário ocupado antes do comprovante',
      );
      return chamarBruna(
        'Recebi seu comprovante, mas esse horário foi ocupado por outra pessoa antes de eu agendar. 💖 Vou chamar a Bruna para falar com você sobre o Pix e um novo horário.',
        'horário ocupado ao receber o comprovante',
      );
    }
    await deps.agendador.agendar({
      nome: proposta.nomeCliente,
      telefone: telefoneNacional(ctx.waId)!,
      profissionalId: proposta.profissionalId,
      servicoId: proposta.servicoId,
      data: proposta.data,
      hora: proposta.hora,
      comentario: 'Agendado pelo assistente virtual do WhatsApp (sinal Pix)',
    });
  } catch (e) {
    await deps.propostas.mudarStatus(proposta.id, 'agendando', 'falhou', String(e));
    deps.log('erro_agendamento', { conversa: ctx.conversaId, erro: String(e) });
    return chamarBruna(
      'Recebi seu comprovante! 💖 Deu um problema no sistema na hora de agendar, então vou chamar a Bruna para finalizar com você.',
      'falha ao agendar depois do comprovante',
    );
  }
  await deps.propostas.mudarStatus(
    proposta.id,
    'agendando',
    'agendado',
    `comprovante recebido (${tipoMidia})`,
  );
  deps.log('agendado', { conversa: ctx.conversaId, proposta: proposta.id });
  const sinal = sinalDoServico(proposta.preco)?.texto ?? '20%';
  try {
    await deps.avisar(
      'IA do salão: novo agendamento pelo WhatsApp',
      `O assistente agendou no Minha Agenda depois de receber um comprovante (${
        tipoMidia === 'document' ? 'PDF' : 'imagem'
      }) na conversa:\n\n${resumo}\n\n` +
        `Sinal combinado: ${sinal}. O sistema NÃO lê o comprovante: confira o Pix no banco e o comprovante no app do WhatsApp Business. Se não for válido, cancele o horário no Minha Agenda.\n`,
    );
  } catch (e) {
    deps.log('erro_aviso_agendamento', { erro: String(e) });
  }
  return {
    acao: 'responder',
    texto: mensagemConfirmacao({
      nome: proposta.nomeCliente,
      data: proposta.data,
      hora: proposta.hora,
      servico: proposta.servicoNome,
      preco: valorDoPreco(proposta.preco),
      profissional: proposta.profissionalNome,
    }),
  };
}

// ---------- o que a IA precisa saber sobre o agendamento da conversa ----------

const JANELA_AGENDADO_RECENTE_MS = 3 * 60_000;

/**
 * Texto para o contexto da IA: proposta aguardando comprovante, ou agendamento feito
 * agora há pouco (para ela não repetir a confirmação que o sistema já mandou).
 * Se o comprovante está sendo processado, espera terminar (até ~20 s).
 */
export async function contextoDoAgendamento(
  repo: Pick<RepositorioPropostas, 'recente' | 'agendadoAtivo'>,
  conversaId: string,
  agora: Date,
  esperar: (ms: number) => Promise<void>,
): Promise<string | null> {
  let r = await repo.recente(conversaId);
  for (let i = 0; r?.status === 'agendando' && i < 5; i++) {
    await esperar(4000);
    r = await repo.recente(conversaId);
  }
  const partes: string[] = [];
  const principal = contextoDaProposta(r, agora);
  if (principal) partes.push(principal);
  const ativo = await repo.agendadoAtivo(conversaId, hojeSaoPaulo(agora));
  if (ativo) {
    partes.push(
      `Agendamento ativo desta cliente (feito pelo sistema): ${
        resumoDoAgendamento(ativo)
      }. Se ela pedir para CANCELAR ou REMARCAR: confirme com ela que é esse horário, pergunte o motivo sem insistir e, para remarcar, o novo dia e horário (consulte com consultar_horarios). No cancelamento, diga com carinho que o sinal NÃO é devolvido (regra da Bruna, sem prometer devolução nem crédito) e pergunte se ela confirma. Só depois do "sim" dela chame cancelar_ou_remarcar_agendamento. Explique a política de cancelamento do salão (está nas regras do agendamento).`,
    );
  }
  return partes.length ? partes.join('\n') : null;
}

/** Quanto esperar depois da proposta antes de conferir o agendamento no Minha Agenda. */
const CONFERIR_DEPOIS_MS = 10 * 60_000;

/**
 * Confere no Minha Agenda se o agendamento ativo da conversa ainda ocupa o horário. Se o
 * horário voltou a aparecer livre com a mesma profissional, a equipe cancelou ou remarcou
 * lá: marca como "cancelado_no_sistema" e devolve um aviso para a IA. Só lê a agenda.
 * Horário ocupado não prova que ainda é dela (outra pessoa pode ter pego), mas livre prova
 * que não é mais. Falha na consulta: não muda nada.
 */
export async function conferirAgendamentoNoSistema(
  repo: Pick<RepositorioPropostas, 'agendadoAtivo' | 'mudarStatus'>,
  consulta: Pick<ConsultaMinhaAgenda, 'vagas'>,
  conversaId: string,
  agora: Date,
  log: (evento: string, dados?: Record<string, unknown>) => void,
): Promise<string | null> {
  const avisos: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ativo = await repo.agendadoAtivo(conversaId, hojeSaoPaulo(agora));
    if (!ativo || agora.getTime() - ativo.criadoEm < CONFERIR_DEPOIS_MS) break;
    let livre: boolean;
    try {
      const r = await consulta.vagas(ativo.servicoId, ativo.data, true);
      livre = !!r.profissionais
        .find((p) => p.id === ativo.profissionalId)
        ?.horarios.includes(ativo.hora);
    } catch (e) {
      log('erro_conferir_agendamento', { conversa: conversaId, erro: String(e) });
      break;
    }
    if (!livre) break;
    await repo.mudarStatus(
      ativo.id,
      'agendado',
      'cancelado_no_sistema',
      'horário livre de novo no Minha Agenda',
    );
    log('agendamento_cancelado_no_sistema', { conversa: conversaId, proposta: ativo.id });
    avisos.push(
      `O agendamento ${
        resumoDoAgendamento(ativo)
      } NÃO está mais na agenda do salão (o horário aparece livre de novo): a equipe cancelou ou remarcou no sistema. Não diga que ela tem esse horário marcado. Se ela perguntar, diga que ele não aparece mais na agenda e, se ela não souber por quê, passe para a Bruna.`,
    );
  }
  return avisos.length ? avisos.join('\n') : null;
}

/**
 * Agenda REAL da cliente, lida do painel do Minha Agenda (inclui o que a Bruna marcou,
 * remarcou ou cancelou direto lá). Também acerta os agendamentos feitos pelo bot: o que
 * não está mais na agenda vira "cancelado_no_sistema". Lança se o painel falhar (quem
 * chama cai na conferência antiga).
 */
export async function contextoDaAgendaReal(
  painel: Pick<PainelMinhaAgenda, 'daCliente'>,
  repo: Pick<RepositorioPropostas, 'agendadoAtivo' | 'mudarStatus' | 'recente'>,
  conversaId: string,
  waId: string,
  agora: Date,
  log: (evento: string, dados?: Record<string, unknown>) => void,
): Promise<string> {
  const hoje = hojeSaoPaulo(agora);
  const datas = proximasDatas(hoje, DIAS_AGENDA_CLIENTE);
  const naAgenda = await painel.daCliente(waId, datas);

  // Agendamentos do bot que sumiram da agenda real (dentro da janela consultada).
  const removidos: Proposta[] = [];
  for (let i = 0; i < 3; i++) {
    const ativo = await repo.agendadoAtivo(conversaId, hoje);
    if (
      !ativo || !datas.includes(ativo.data) ||
      agora.getTime() - ativo.criadoEm < CONFERIR_DEPOIS_MS
    ) break;
    const continua = naAgenda.some((a) =>
      a.data === ativo.data && a.inicio === ativo.hora &&
      a.profissionalId === ativo.profissionalId
    );
    if (continua) break;
    await repo.mudarStatus(
      ativo.id,
      'agendado',
      'cancelado_no_sistema',
      'não está mais na agenda do painel do Minha Agenda',
    );
    log('agendamento_cancelado_no_sistema', { conversa: conversaId, proposta: ativo.id });
    removidos.push(ativo);
  }
  // Também o que já tinha sido marcado antes (para a IA continuar sabendo).
  const recente = await repo.recente(conversaId);
  if (
    recente?.status === 'cancelado_no_sistema' && recente.data >= hoje &&
    !removidos.some((r) => r.id === recente.id)
  ) removidos.push(recente);

  const partes = [
    `AGENDA REAL DO SALÃO (consultada agora no sistema, de hoje até ${
      dataCurta(datas[datas.length - 1])
    }). Ela é a FONTE DA VERDADE: vale mais do que qualquer coisa dita antes na conversa, inclusive mensagens suas, propostas, comprovantes e confirmações. Se houver diferença, a equipe mudou no sistema: siga a agenda, sem desconfiar dela e sem chamar a Bruna só por causa da diferença.`,
  ];
  if (naAgenda.length === 0) {
    partes.push(
      'Esta cliente NÃO tem nenhum horário marcado nesse período. Se ela perguntar, diga isso com clareza; não diga que ela tem horário.',
    );
  } else {
    partes.push(
      `Horários desta cliente na agenda:\n${
        naAgenda.map((a) =>
          `- [agendamento ${a.id}] ${a.servico}, ${
            dataCurta(a.data)
          }, às ${a.inicio}, com ${a.profissionalNome}${
            a.preco ? `, ${reais(a.preco)}` : ''
          }`
        ).join('\n')
      }\nSe ela pedir para CANCELAR ou REMARCAR um desses horários, siga o roteiro: confirme qual é, pergunte o motivo sem insistir e, para remarcar, o novo dia e horário (consulte com consultar_horarios); com tudo em mãos e ela confirmando, chame cancelar_ou_remarcar_agendamento com agendamento_sistema_id = o número entre colchetes desse horário (no cancelamento, avise antes que o sinal não é devolvido). Só chame se ela pediu para cancelar ou remarcar e confirmou.`,
    );
  }
  for (const r of removidos) {
    partes.push(
      `O agendamento ${
        resumoDoAgendamento(r)
      }, feito por aqui antes, NÃO está mais na agenda: a equipe cancelou ou alterou no sistema, então a Bruna já sabe. Se ela perguntar dele, diga com carinho que ele não consta mais na agenda do salão e ofereça ver outro horário. NÃO chame a Bruna por causa disso, nem por causa de Pix, sinal ou comprovante mandados antes na conversa. Só chame se, na mensagem atual, a cliente pedir uma pessoa, perguntar o motivo do cancelamento ou falar em devolver o sinal.`,
    );
  }
  return partes.join('\n');
}

function contextoDaProposta(
  r: PropostaRecente | null,
  agora: Date,
): string | null {
  if (!r) return null;
  const servico = r.servicoNome.replace(/\s*\(a partir de\)/i, '');
  const resumo =
    `${servico}, ${r.data} às ${r.hora} com ${r.profissionalNome}, no nome de ${r.nomeCliente}`;
  if (r.status === 'proposto' && r.expiraEm >= agora.getTime()) {
    return `Proposta pendente desta conversa, registrada pelo sistema, aguardando o comprovante do Pix e AINDA NÃO agendada: ${resumo}. Se a cliente perguntar ou disser que pagou, peça o comprovante (imagem ou PDF) aqui na conversa. Nunca diga que está agendado: o sistema agenda sozinho quando o comprovante chega.`;
  }
  if (
    r.status === 'agendado' &&
    agora.getTime() - r.atualizadoEm <= JANELA_AGENDADO_RECENTE_MS
  ) {
    return `O sistema acabou de agendar (${resumo}) depois de receber o comprovante, e a mensagem de confirmação já foi enviada à cliente. Não repita a confirmação nem o resumo e não peça comprovante. Responda só se ela perguntar algo; se a mensagem for apenas um agradecimento ou um aviso de que mandou o comprovante, deixe "resposta" vazia.`;
  }
  return null;
}
