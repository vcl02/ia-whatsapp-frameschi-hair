// Acesso ao banco com a service role (só dentro das Edge Functions).

import { createClient, type SupabaseClient } from './deps.ts';
import type {
  EcoEnviado,
  ListasNumeros,
  MensagemRecebida,
  ResultadoEnvio,
  StatusRecebido,
} from './whatsapp.ts';
import type { Servico } from './salao.ts';
import type { Conversa, Repositorio } from './bot.ts';
import {
  type Aprendizado,
  CONFIG_PADRAO,
  type ConfigIA,
  type Esforco,
  ESFORCOS_PERMITIDOS,
  type ItemHistorico,
  MAX_APRENDIZADOS,
  MODELOS_PERMITIDOS,
} from './llm.ts';
import type { ArmazemSessao, Sessao } from './disponibilidade.ts';
import {
  type NovoPedido,
  type Proposta,
  type PropostaRecente,
  type RepositorioPedidos,
  type RepositorioPropostas,
  resumoDoAgendamento,
  resumoDoPedido,
} from './agendamento.ts';
import type { PropostaParaLembrete, RepositorioLembretes } from './lembrete.ts';
import type { PedidoParaExecutar, RepositorioExecucao } from './execucao.ts';
import type { PedidoPendente, RepositorioFechamento } from './fechamento.ts';
import type {
  AgendamentoPainel,
  ArmazemTokenPainel,
  CacheAgenda,
  TokenPainel,
} from './painel_minhaagenda.ts';

export function clienteServico(): SupabaseClient {
  return createClient(
    exigirEnv('SUPABASE_URL'),
    exigirEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { persistSession: false },
    },
  );
}

export function exigirEnv(nome: string): string {
  const v = Deno.env.get(nome);
  if (!v) throw new Error(`variável de ambiente ausente: ${nome}`);
  return v;
}

function checar<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data;
}

export class RepositorioSupabase implements Repositorio {
  constructor(private db: SupabaseClient) {}

  /**
   * Grava a mensagem recebida. `nova` = false quando a Meta reenviou a mesma.
   * Conversa nova nasce com a IA pausada se o botão geral estiver desligado
   * (`iaLigadaParaNovas`); conversa que já existe nunca é afetada por ele.
   * Número de teste com a IA pausada: a mensagem fica fora do contexto da IA.
   */
  async registrarEntrada(
    m: MensagemRecebida,
    iaLigadaParaNovas = true,
    numeroDeTeste = false,
  ): Promise<{ conversaId: string; nova: boolean }> {
    const existente = checar(
      await this.db
        .from('salao_conversas')
        .select('id, bot_pausado')
        .eq('wa_id', m.waId)
        .maybeSingle(),
    ) as { id: string; bot_pausado: boolean } | null;
    const pausada = existente ? existente.bot_pausado : !iaLigadaParaNovas;
    const conversa = checar(
      await this.db
        .from('salao_conversas')
        .upsert(
          {
            wa_id: m.waId,
            ...(m.nomePerfil ? { nome_perfil: m.nomePerfil } : {}),
            ultimo_inbound_em: m.recebidaEm.toISOString(),
            atualizado_em: new Date().toISOString(),
            ...(existente ? {} : { bot_pausado: !iaLigadaParaNovas }),
          },
          { onConflict: 'wa_id' },
        )
        .select('id')
        .single(),
    ) as { id: string };

    const inserida = checar(
      await this.db
        .from('salao_mensagens')
        .upsert(
          {
            conversa_id: conversa.id,
            direcao: 'entrada',
            autor: 'cliente',
            wamid: m.wamid,
            tipo: m.tipo,
            texto: m.texto,
            fora_contexto: numeroDeTeste && pausada,
            criado_em: m.recebidaEm.toISOString(),
          },
          { onConflict: 'wamid', ignoreDuplicates: true },
        )
        .select('id'),
    ) as unknown[];

    return { conversaId: conversa.id, nova: inserida.length > 0 };
  }

  async registrarStatus(s: StatusRecebido): Promise<void> {
    checar(
      await this.db.from('salao_status').upsert(
        {
          wamid: s.wamid,
          status: s.status,
          recipient_id: s.recipientId,
          ocorrido_em: s.ocorridoEm?.toISOString() ?? null,
          erros: s.erros,
          conversation: s.conversation,
          pricing: s.pricing,
        },
        { onConflict: 'wamid,status,ocorrido_em', ignoreDuplicates: true },
      ),
    );
  }

  /**
   * Botão geral da IA (vale só para conversas novas). Se a tabela ainda não
   * existir, segue ligada; qualquer outro erro propaga e nada é respondido.
   */
  async iaAtiva(): Promise<boolean> {
    const { data, error } = await this.db
      .from('salao_controle')
      .select('ia_ativa')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '42P01' || code === 'PGRST205') return true;
      throw error;
    }
    return data?.ia_ativa !== false;
  }

  /**
   * Modelo, esforço e limites do painel. Valor desconhecido ou migration ainda
   * não aplicada: usa o padrão (sem derrubar o atendimento).
   */
  async config(): Promise<ConfigIA> {
    const { data, error } = await this.db
      .from('salao_controle')
      .select('modelo, esforco, limite_conversa_hora, limite_global_dia')
      .eq('id', 1)
      .maybeSingle();
    if (error || !data) return CONFIG_PADRAO;
    const r = data as {
      modelo: string;
      esforco: string;
      limite_conversa_hora: number;
      limite_global_dia: number;
    };
    return {
      modelo: (MODELOS_PERMITIDOS as readonly string[]).includes(r.modelo)
        ? r.modelo
        : CONFIG_PADRAO.modelo,
      esforco: (ESFORCOS_PERMITIDOS as readonly string[]).includes(r.esforco)
        ? (r.esforco as Esforco)
        : CONFIG_PADRAO.esforco,
      limiteConversaHora: Number(r.limite_conversa_hora) ||
        CONFIG_PADRAO.limiteConversaHora,
      limiteGlobalDia: Number(r.limite_global_dia) || CONFIG_PADRAO.limiteGlobalDia,
    };
  }

  /** Listas de teste e de familiares (tabela salao_numeros, editada no painel). */
  async listasNumeros(): Promise<ListasNumeros> {
    const { data, error } = await this.db
      .from('salao_numeros')
      .select('wa_id, lista');
    if (error) throw error; // sem as listas, nada é respondido
    const r = data as { wa_id: string; lista: string }[];
    return {
      teste: new Set(r.filter((x) => x.lista === 'teste').map((x) => x.wa_id)),
      familiar: new Set(
        r.filter((x) => x.lista === 'familiar').map((x) => x.wa_id),
      ),
    };
  }

  async conversa(id: string): Promise<Conversa> {
    const r = checar(
      await this.db
        .from('salao_conversas')
        .select('id, wa_id, nome_perfil, nome_cliente, bot_pausado')
        .eq('id', id)
        .single(),
    ) as {
      id: string;
      wa_id: string;
      nome_perfil: string | null;
      nome_cliente: string | null;
      bot_pausado: boolean;
    };
    return {
      id: r.id,
      waId: r.wa_id,
      // o nome editado no painel vale mais que o do perfil do WhatsApp
      nomePerfil: r.nome_cliente ?? r.nome_perfil,
      botPausado: r.bot_pausado,
    };
  }

  async temSaida(conversaId: string): Promise<boolean> {
    const r = checar(
      await this.db
        .from('salao_mensagens')
        .select('id')
        .eq('conversa_id', conversaId)
        .eq('direcao', 'saida')
        .limit(1),
    ) as unknown[];
    return r.length > 0;
  }

  async servicosAtivos(): Promise<Servico[]> {
    return checar(
      await this.db
        .from('salao_servicos')
        .select('origem_id, nome, preco, duracao, observacao')
        .eq('ativo', true)
        .order('ordem')
        .order('nome'),
    ) as Servico[];
  }

  async infoSalao(): Promise<Record<string, string>> {
    const r = checar(
      await this.db.from('salao_info').select('chave, valor'),
    ) as { chave: string; valor: string }[];
    return Object.fromEntries(r.map((x) => [x.chave, x.valor]));
  }

  async respostasDoBot(
    conversaId: string | null,
    desde: Date,
  ): Promise<number> {
    let q = this.db
      .from('salao_mensagens')
      .select('id', { count: 'exact', head: true })
      .eq('autor', 'bot')
      .gte('criado_em', desde.toISOString());
    if (conversaId) q = q.eq('conversa_id', conversaId);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  }

  async ultimoInboundDe(waId: string): Promise<Date | null> {
    const r = checar(
      await this.db
        .from('salao_conversas')
        .select('ultimo_inbound_em')
        .eq('wa_id', waId)
        .maybeSingle(),
    ) as { ultimo_inbound_em: string | null } | null;
    return r?.ultimo_inbound_em ? new Date(r.ultimo_inbound_em) : null;
  }

  /**
   * Mensagem enviada pelo app do celular (coexistência): registra como humana
   * e pausa o bot, porque alguém assumiu a conversa.
   */
  async registrarEco(e: EcoEnviado, numeroDeTeste = false): Promise<void> {
    // Se o wamid já existe, a mensagem foi enviada por nós (bot ou tela): ignora.
    const ja = checar(
      await this.db
        .from('salao_mensagens')
        .select('id')
        .eq('wamid', e.wamid)
        .limit(1),
    ) as unknown[];
    if (ja.length > 0) return;
    const conversa = checar(
      await this.db
        .from('salao_conversas')
        .upsert(
          {
            wa_id: e.para,
            bot_pausado: true,
            atualizado_em: new Date().toISOString(),
          },
          { onConflict: 'wa_id' },
        )
        .select('id')
        .single(),
    ) as { id: string };
    checar(
      await this.db.from('salao_mensagens').upsert(
        {
          conversa_id: conversa.id,
          direcao: 'saida',
          autor: 'humano',
          wamid: e.wamid,
          tipo: e.tipo,
          texto: e.texto,
          status: 'enviada_pelo_app',
          fora_contexto: numeroDeTeste,
          criado_em: e.enviadaEm.toISOString(),
        },
        { onConflict: 'wamid', ignoreDuplicates: true },
      ),
    );
  }

  async ultimaEntradaWamid(conversaId: string): Promise<string | null> {
    const r = checar(
      await this.db
        .from('salao_mensagens')
        .select('wamid')
        .eq('conversa_id', conversaId)
        .eq('direcao', 'entrada')
        .order('criado_em', { ascending: false })
        .limit(1),
    ) as { wamid: string | null }[];
    return r[0]?.wamid ?? null;
  }

  async aprendizados(conversaId: string): Promise<Aprendizado[]> {
    return checar(
      await this.db
        .from('salao_aprendizados')
        .select('escopo, situacao, texto, exemplo')
        .eq('ativo', true)
        .or(`conversa_id.is.null,conversa_id.eq.${conversaId}`)
        .order('criado_em', { ascending: true })
        .limit(MAX_APRENDIZADOS),
    ) as Aprendizado[];
  }

  async historico(
    conversaId: string,
    limite: number,
  ): Promise<ItemHistorico[]> {
    const r = checar(
      await this.db
        .from('salao_mensagens')
        .select('autor, texto, tipo')
        .eq('conversa_id', conversaId)
        .eq('fora_contexto', false)
        .order('criado_em', { ascending: false })
        .limit(limite),
    ) as {
      autor: ItemHistorico['autor'];
      texto: string | null;
      tipo: string;
    }[];
    return r
      .reverse()
      .map((m) => ({ autor: m.autor, texto: m.texto ?? `[${m.tipo}]` }));
  }

  async registrarSaida(
    conversaId: string,
    autor: 'bot' | 'humano',
    texto: string,
    envio: ResultadoEnvio,
  ): Promise<void> {
    checar(
      await this.db.from('salao_mensagens').insert({
        conversa_id: conversaId,
        direcao: 'saida',
        autor,
        wamid: envio.wamid,
        tipo: 'text',
        texto,
        status: envio.ok ? 'aceita' : 'erro_envio',
        erro: envio.ok ? null : { http: envio.httpStatus, erro: envio.erro },
      }),
    );
    checar(
      await this.db
        .from('salao_conversas')
        .update({ atualizado_em: new Date().toISOString() })
        .eq('id', conversaId),
    );
  }

  async marcarHumano(conversaId: string, motivo: string): Promise<void> {
    checar(
      await this.db
        .from('salao_conversas')
        .update({
          bot_pausado: true,
          precisa_humano: true,
          motivo_humano: motivo,
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', conversaId),
    );
  }
}

/** Guarda a sessão anônima do Minha Agenda (tabela só do servidor). */
export class ArmazemSessaoSupabase implements ArmazemSessao {
  constructor(private db: SupabaseClient) {}

  async ler(): Promise<Sessao | null> {
    const r = checar(
      await this.db
        .from('salao_sessao_minhaagenda')
        .select('id_token, refresh_token, expira_em, cadastrado')
        .eq('id', 1)
        .maybeSingle(),
    ) as {
      id_token: string;
      refresh_token: string;
      expira_em: string;
      cadastrado: boolean;
    } | null;
    return r
      ? {
        idToken: r.id_token,
        refreshToken: r.refresh_token,
        expiraEm: new Date(r.expira_em).getTime(),
        cadastrado: r.cadastrado,
      }
      : null;
  }

  async gravar(s: Sessao | null): Promise<void> {
    if (!s) {
      checar(
        await this.db.from('salao_sessao_minhaagenda').delete().eq('id', 1),
      );
      return;
    }
    checar(
      await this.db.from('salao_sessao_minhaagenda').upsert({
        id: 1,
        id_token: s.idToken,
        refresh_token: s.refreshToken,
        expira_em: new Date(s.expiraEm).toISOString(),
        cadastrado: s.cadastrado,
        atualizado_em: new Date().toISOString(),
      }),
    );
  }
}

type LinhaAgendamento = {
  id: string;
  conversa_id: string;
  servico_origem_id: number;
  servico_nome: string;
  profissional_id: number;
  profissional_nome: string;
  data: string;
  hora: string;
  preco: string | null;
  nome_cliente: string;
  expira_em: string;
  criado_em: string;
  status?: string;
  atualizado_em?: string;
  remarcado_de?: string | null;
};

function paraProposta(r: LinhaAgendamento): Proposta {
  return {
    id: r.id,
    conversaId: r.conversa_id,
    servicoId: Number(r.servico_origem_id),
    servicoNome: r.servico_nome,
    profissionalId: Number(r.profissional_id),
    profissionalNome: r.profissional_nome,
    data: r.data,
    hora: r.hora,
    preco: r.preco,
    nomeCliente: r.nome_cliente,
    expiraEm: new Date(r.expira_em).getTime(),
    criadoEm: new Date(r.criado_em).getTime(),
    remarcadoDe: r.remarcado_de ?? null,
  };
}

/** Propostas e agendamentos do bot (tabela salao_agendamentos). */
export class RepositorioPropostasSupabase implements RepositorioPropostas {
  constructor(private db: SupabaseClient) {}

  async criar(p: Omit<Proposta, 'id' | 'criadoEm'>): Promise<Proposta> {
    checar(
      await this.db
        .from('salao_agendamentos')
        .update({
          status: 'substituido',
          atualizado_em: new Date().toISOString(),
        })
        .eq('conversa_id', p.conversaId)
        .eq('status', 'proposto'),
    );
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .insert({
          conversa_id: p.conversaId,
          servico_origem_id: p.servicoId,
          servico_nome: p.servicoNome,
          profissional_id: p.profissionalId,
          profissional_nome: p.profissionalNome,
          data: p.data,
          hora: p.hora,
          preco: p.preco,
          nome_cliente: p.nomeCliente,
          status: 'proposto',
          expira_em: new Date(p.expiraEm).toISOString(),
        })
        .select('*')
        .single(),
    ) as LinhaAgendamento;
    return paraProposta(r);
  }

  async recente(conversaId: string): Promise<PropostaRecente | null> {
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .select('*')
        .eq('conversa_id', conversaId)
        .order('criado_em', { ascending: false })
        .limit(1),
    ) as LinhaAgendamento[];
    if (!r[0]) return null;
    return {
      ...paraProposta(r[0]),
      status: r[0].status ?? '',
      atualizadoEm: new Date(r[0].atualizado_em ?? r[0].criado_em).getTime(),
    };
  }

  async pendente(conversaId: string): Promise<Proposta | null> {
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .select('*')
        .eq('conversa_id', conversaId)
        .eq('status', 'proposto')
        .order('criado_em', { ascending: false })
        .limit(1),
    ) as LinhaAgendamento[];
    return r[0] ? paraProposta(r[0]) : null;
  }

  async mudarStatus(
    id: string,
    de: string,
    para: string,
    detalhe?: string,
  ): Promise<boolean> {
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .update({
          status: para,
          atualizado_em: new Date().toISOString(),
          ...(detalhe ? { detalhe } : {}),
        })
        .eq('id', id)
        .eq('status', de)
        .select('id'),
    ) as unknown[];
    return r.length > 0;
  }

  async agendadoAtivo(
    conversaId: string,
    hoje: string,
  ): Promise<Proposta | null> {
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .select('*')
        .eq('conversa_id', conversaId)
        .eq('status', 'agendado')
        .is('cancelamento_pedido_em', null)
        .gte('data', hoje)
        .order('atualizado_em', { ascending: false })
        .limit(1),
    ) as LinhaAgendamento[];
    return r[0] ? paraProposta(r[0]) : null;
  }

  async marcarCancelamentoPedido(
    conversaId: string,
    hoje: string,
  ): Promise<string | null> {
    const ativo = await this.agendadoAtivo(conversaId, hoje);
    if (!ativo) return null;
    checar(
      await this.db
        .from('salao_agendamentos')
        .update({ cancelamento_pedido_em: new Date().toISOString() })
        .eq('id', ativo.id),
    );
    return resumoDoAgendamento(ativo);
  }

  async agendadosDesde(conversaId: string, desde: Date): Promise<number> {
    const { count, error } = await this.db
      .from('salao_agendamentos')
      .select('id', { count: 'exact', head: true })
      .eq('conversa_id', conversaId)
      .eq('status', 'agendado')
      .gte('atualizado_em', desde.toISOString());
    if (error) throw error;
    return count ?? 0;
  }
}

/** Pedidos de cancelamento e remarcação para a Bruna finalizar (tabela salao_pedidos). */
export class RepositorioPedidosSupabase implements RepositorioPedidos {
  constructor(private db: SupabaseClient) {}

  async criar(p: NovoPedido): Promise<string> {
    checar(
      await this.db
        .from('salao_pedidos')
        .update({ status: 'substituido' })
        .eq('conversa_id', p.conversaId)
        .eq('status', 'pendente'),
    );
    const r = checar(
      await this.db
        .from('salao_pedidos')
        .insert({
          conversa_id: p.conversaId,
          agendamento_id: p.agendamentoId,
          agendamento_sistema_id: p.agendamentoSistemaId ?? null,
          agendamento_data: p.agendamentoData ?? null,
          agendamento_hora: p.agendamentoHora ?? null,
          tipo: p.tipo,
          horario_atual: p.horarioAtual,
          novo_data: p.novoData,
          novo_hora: p.novoHora,
          novo_profissional: p.novoProfissional,
          motivo: p.motivo,
          observacao: p.observacao,
        })
        .select('id')
        .single(),
    ) as { id: string };
    return r.id;
  }

  async resumoPendente(conversaId: string): Promise<string | null> {
    const r = checar(
      await this.db
        .from('salao_pedidos')
        .select(
          'tipo, horario_atual, novo_data, novo_hora, novo_profissional',
        )
        .eq('conversa_id', conversaId)
        .eq('status', 'pendente')
        .order('criado_em', { ascending: false })
        .limit(1),
    ) as Array<{
      tipo: NovoPedido['tipo'];
      horario_atual: string | null;
      novo_data: string | null;
      novo_hora: string | null;
      novo_profissional: string | null;
    }>;
    if (!r[0]) return null;
    return resumoDoPedido({
      conversaId,
      agendamentoId: null,
      tipo: r[0].tipo,
      horarioAtual: r[0].horario_atual,
      novoData: r[0].novo_data,
      novoHora: r[0].novo_hora,
      novoProfissional: r[0].novo_profissional,
      motivo: '',
      observacao: '',
    });
  }
}

/** Propostas aguardando comprovante, para os lembretes a cada 7 minutos. */
export class LembretesSupabase implements RepositorioLembretes {
  constructor(private db: SupabaseClient) {}

  async listar(): Promise<PropostaParaLembrete[]> {
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .select(
          'id, conversa_id, nome_cliente, servico_nome, data, hora, preco, criado_em, expira_em, lembretes, salao_conversas(wa_id, bot_pausado)',
        )
        .eq('status', 'proposto')
        .gt('expira_em', new Date(Date.now() - 60 * 60_000).toISOString()),
    ) as Array<
      LinhaAgendamento & {
        lembretes: number;
        salao_conversas:
          | { wa_id: string; bot_pausado: boolean }
          | Array<{ wa_id: string; bot_pausado: boolean }>
          | null;
      }
    >;
    return r.flatMap((x) => {
      const c = Array.isArray(x.salao_conversas)
        ? x.salao_conversas[0]
        : x.salao_conversas;
      if (!c) return [];
      return [
        {
          id: x.id,
          conversaId: x.conversa_id,
          waId: c.wa_id,
          botPausado: c.bot_pausado,
          nomeCliente: x.nome_cliente,
          servicoNome: x.servico_nome,
          data: x.data,
          hora: x.hora,
          preco: x.preco,
          criadoEm: new Date(x.criado_em).getTime(),
          expiraEm: new Date(x.expira_em).getTime(),
          lembretes: Number(x.lembretes),
        },
      ];
    });
  }

  /** Marca o lembrete como enviado antes de mandar; false se outra execução já pegou. */
  async reservar(
    id: string,
    atual: number,
    expirar = false,
  ): Promise<boolean> {
    const r = checar(
      await this.db
        .from('salao_agendamentos')
        .update({
          lembretes: atual + 1,
          ...(expirar
            ? { status: 'expirado', atualizado_em: new Date().toISOString() }
            : {}),
        })
        .eq('id', id)
        .eq('lembretes', atual)
        .eq('status', 'proposto')
        .select('id'),
    ) as unknown[];
    return r.length > 0;
  }
}

/** Token do painel do Minha Agenda (login da Bruna), reaproveitado até vencer. */
export class ArmazemTokenPainelSupabase implements ArmazemTokenPainel {
  constructor(private db: SupabaseClient) {}

  async ler(): Promise<TokenPainel | null> {
    const r = checar(
      await this.db
        .from('salao_token_painel')
        .select('token, expira_em')
        .eq('id', 1)
        .maybeSingle(),
    ) as { token: string; expira_em: string } | null;
    return r ? { token: r.token, expiraEm: new Date(r.expira_em).getTime() } : null;
  }

  async gravar(t: TokenPainel | null): Promise<void> {
    if (!t) {
      checar(await this.db.from('salao_token_painel').delete().eq('id', 1));
      return;
    }
    checar(
      await this.db.from('salao_token_painel').upsert({
        id: 1,
        token: t.token,
        expira_em: new Date(t.expiraEm).toISOString(),
        atualizado_em: new Date().toISOString(),
      }),
    );
  }
}

/** Agenda de cada dia lida do painel, guardada por alguns minutos. */
export class CacheAgendaSupabase implements CacheAgenda {
  constructor(private db: SupabaseClient, private agora: () => number = Date.now) {}

  async ler(data: string, maxIdadeMs: number): Promise<AgendamentoPainel[] | null> {
    const r = checar(
      await this.db
        .from('salao_agenda_cache')
        .select('itens, atualizado_em')
        .eq('data', data)
        .maybeSingle(),
    ) as { itens: AgendamentoPainel[]; atualizado_em: string } | null;
    if (!r) return null;
    return this.agora() - new Date(r.atualizado_em).getTime() < maxIdadeMs
      ? r.itens
      : null;
  }

  async gravar(data: string, itens: AgendamentoPainel[]): Promise<void> {
    checar(
      await this.db.from('salao_agenda_cache').upsert({
        data,
        itens,
        atualizado_em: new Date(this.agora()).toISOString(),
      }),
    );
  }
}

/** Pedidos aprovados pela Bruna no painel, para executar no Minha Agenda. */
export class RepositorioExecucaoSupabase implements RepositorioExecucao {
  constructor(private db: SupabaseClient) {}

  async carregar(id: string): Promise<PedidoParaExecutar | null> {
    const r = checar(
      await this.db
        .from('salao_pedidos')
        .select(
          'id, conversa_id, tipo, status, agendamento_id, agendamento_sistema_id, novo_data, novo_hora, novo_profissional, salao_conversas(wa_id, ultimo_inbound_em)',
        )
        .eq('id', id)
        .eq('status', 'pendente')
        .maybeSingle(),
    ) as {
      id: string;
      conversa_id: string;
      tipo: string;
      agendamento_id: string | null;
      agendamento_sistema_id: number | null;
      novo_data: string | null;
      novo_hora: string | null;
      novo_profissional: string | null;
      salao_conversas:
        | { wa_id: string; ultimo_inbound_em: string | null }
        | Array<{ wa_id: string; ultimo_inbound_em: string | null }>
        | null;
    } | null;
    if (!r) return null;
    const c = Array.isArray(r.salao_conversas) ? r.salao_conversas[0] : r.salao_conversas;
    if (!c) return null;
    return {
      id: r.id,
      conversaId: r.conversa_id,
      waId: c.wa_id,
      tipo: r.tipo,
      agendamentoSistemaId: r.agendamento_sistema_id == null
        ? null
        : Number(r.agendamento_sistema_id),
      agendamentoId: r.agendamento_id,
      novoData: r.novo_data,
      novoHora: r.novo_hora,
      novoProfissional: r.novo_profissional,
      ultimoInbound: c.ultimo_inbound_em ? new Date(c.ultimo_inbound_em) : null,
    };
  }

  async reservar(id: string): Promise<boolean> {
    const r = checar(
      await this.db
        .from('salao_pedidos')
        .update({ executado_em: new Date().toISOString(), resultado: 'executando' })
        .eq('id', id)
        .eq('status', 'pendente')
        .is('executado_em', null)
        .select('id'),
    ) as unknown[];
    return r.length > 0;
  }

  async guardarCopia(id: string, copia: Record<string, unknown>): Promise<void> {
    checar(
      await this.db.from('salao_pedidos').update({ copia_agendamento: copia }).eq(
        'id',
        id,
      ),
    );
  }

  async concluir(id: string, resultado: string): Promise<void> {
    checar(
      await this.db
        .from('salao_pedidos')
        .update({ status: 'feito', feito_em: new Date().toISOString(), resultado })
        .eq('id', id),
    );
  }

  /** Quantos cancelamentos/remarcações a IA fez nesta conversa desde `desde`. */
  async feitosPelaIADesde(conversaId: string, desde: Date): Promise<number> {
    const { count, error } = await this.db
      .from('salao_pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('conversa_id', conversaId)
      .eq('status', 'feito')
      .like('resultado', 'Feito pela IA%')
      .gte('feito_em', desde.toISOString());
    if (error) throw error;
    return count ?? 0;
  }

  async liberar(id: string, erro: string): Promise<void> {
    checar(
      await this.db
        .from('salao_pedidos')
        .update({ executado_em: null, resultado: `Não feito: ${erro}`.slice(0, 500) })
        .eq('id', id),
    );
  }

  async acertarAgendamentoBot(
    agendamentoId: string,
    novo:
      | { data: string; hora: string; profissionalId: number; profissionalNome: string }
      | null,
  ): Promise<void> {
    checar(
      await this.db
        .from('salao_agendamentos')
        .update(
          novo
            ? {
              data: novo.data,
              hora: novo.hora,
              profissional_id: novo.profissionalId,
              profissional_nome: novo.profissionalNome,
              cancelamento_pedido_em: null,
              atualizado_em: new Date().toISOString(),
            }
            : {
              status: 'cancelado_no_sistema',
              detalhe: 'cancelado pela Bruna pelo painel do salão',
              atualizado_em: new Date().toISOString(),
            },
        )
        .eq('id', agendamentoId),
    );
  }
}

/** Pedidos pendentes que a Bruna pode ter resolvido direto no Minha Agenda. */
export class RepositorioFechamentoSupabase implements RepositorioFechamento {
  constructor(private db: SupabaseClient) {}

  async pendentes(): Promise<PedidoPendente[]> {
    const r = checar(
      await this.db
        .from('salao_pedidos')
        .select(
          'id, tipo, agendamento_sistema_id, agendamento_data, agendamento_hora, novo_data, novo_hora',
        )
        .eq('status', 'pendente')
        .not('agendamento_sistema_id', 'is', null)
        .not('agendamento_data', 'is', null),
    ) as Array<{
      id: string;
      tipo: string;
      agendamento_sistema_id: number;
      agendamento_data: string;
      agendamento_hora: string | null;
      novo_data: string | null;
      novo_hora: string | null;
    }>;
    return r.map((x) => ({
      id: x.id,
      tipo: x.tipo,
      agendamentoSistemaId: Number(x.agendamento_sistema_id),
      data: x.agendamento_data,
      hora: x.agendamento_hora,
      novoData: x.novo_data,
      novoHora: x.novo_hora,
    }));
  }

  async fechar(id: string, resultado: string): Promise<void> {
    checar(
      await this.db
        .from('salao_pedidos')
        .update({ status: 'feito', feito_em: new Date().toISOString(), resultado })
        .eq('id', id)
        .eq('status', 'pendente'),
    );
  }
}
