// Acesso ao banco com a service role (só dentro das Edge Functions).

import { createClient, type SupabaseClient } from "./deps.ts";
import type {
  EcoEnviado,
  MensagemRecebida,
  ResultadoEnvio,
  StatusRecebido,
} from "./whatsapp.ts";
import type { Servico } from "./salao.ts";
import type { Conversa, Repositorio } from "./bot.ts";
import type { ItemHistorico } from "./llm.ts";
import type { ArmazemSessao, Sessao } from "./disponibilidade.ts";
import type { Proposta, RepositorioPropostas } from "./agendamento.ts";

export function clienteServico(): SupabaseClient {
  return createClient(
    exigirEnv("SUPABASE_URL"),
    exigirEnv("SUPABASE_SERVICE_ROLE_KEY"),
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

  /** Grava a mensagem recebida. `nova` = false quando a Meta reenviou a mesma. */
  async registrarEntrada(
    m: MensagemRecebida,
  ): Promise<{ conversaId: string; nova: boolean }> {
    const conversa = checar(
      await this.db
        .from("salao_conversas")
        .upsert(
          {
            wa_id: m.waId,
            ...(m.nomePerfil ? { nome_perfil: m.nomePerfil } : {}),
            ultimo_inbound_em: m.recebidaEm.toISOString(),
            atualizado_em: new Date().toISOString(),
          },
          { onConflict: "wa_id" },
        )
        .select("id")
        .single(),
    ) as { id: string };

    const inserida = checar(
      await this.db
        .from("salao_mensagens")
        .upsert(
          {
            conversa_id: conversa.id,
            direcao: "entrada",
            autor: "cliente",
            wamid: m.wamid,
            tipo: m.tipo,
            texto: m.texto,
            criado_em: m.recebidaEm.toISOString(),
          },
          { onConflict: "wamid", ignoreDuplicates: true },
        )
        .select("id"),
    ) as unknown[];

    return { conversaId: conversa.id, nova: inserida.length > 0 };
  }

  async registrarStatus(s: StatusRecebido): Promise<void> {
    checar(
      await this.db.from("salao_status").upsert(
        {
          wamid: s.wamid,
          status: s.status,
          recipient_id: s.recipientId,
          ocorrido_em: s.ocorridoEm?.toISOString() ?? null,
          erros: s.erros,
          conversation: s.conversation,
          pricing: s.pricing,
        },
        { onConflict: "wamid,status,ocorrido_em", ignoreDuplicates: true },
      ),
    );
  }

  async conversa(id: string): Promise<Conversa> {
    const r = checar(
      await this.db
        .from("salao_conversas")
        .select("id, wa_id, nome_perfil, bot_pausado")
        .eq("id", id)
        .single(),
    ) as {
      id: string;
      wa_id: string;
      nome_perfil: string | null;
      bot_pausado: boolean;
    };
    return {
      id: r.id,
      waId: r.wa_id,
      nomePerfil: r.nome_perfil,
      botPausado: r.bot_pausado,
    };
  }

  async temSaida(conversaId: string): Promise<boolean> {
    const r = checar(
      await this.db
        .from("salao_mensagens")
        .select("id")
        .eq("conversa_id", conversaId)
        .eq("direcao", "saida")
        .limit(1),
    ) as unknown[];
    return r.length > 0;
  }

  async servicosAtivos(): Promise<Servico[]> {
    return checar(
      await this.db
        .from("salao_servicos")
        .select("origem_id, nome, preco, duracao, observacao")
        .eq("ativo", true)
        .order("ordem")
        .order("nome"),
    ) as Servico[];
  }

  async infoSalao(): Promise<Record<string, string>> {
    const r = checar(
      await this.db.from("salao_info").select("chave, valor"),
    ) as { chave: string; valor: string }[];
    return Object.fromEntries(r.map((x) => [x.chave, x.valor]));
  }

  async respostasDoBot(
    conversaId: string | null,
    desde: Date,
  ): Promise<number> {
    let q = this.db
      .from("salao_mensagens")
      .select("id", { count: "exact", head: true })
      .eq("autor", "bot")
      .gte("criado_em", desde.toISOString());
    if (conversaId) q = q.eq("conversa_id", conversaId);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  }

  async ultimoInboundDe(waId: string): Promise<Date | null> {
    const r = checar(
      await this.db
        .from("salao_conversas")
        .select("ultimo_inbound_em")
        .eq("wa_id", waId)
        .maybeSingle(),
    ) as { ultimo_inbound_em: string | null } | null;
    return r?.ultimo_inbound_em ? new Date(r.ultimo_inbound_em) : null;
  }

  /**
   * Mensagem enviada pelo app do celular (coexistência): registra como humana
   * e pausa o bot, porque alguém assumiu a conversa.
   */
  async registrarEco(e: EcoEnviado): Promise<void> {
    // Se o wamid já existe, a mensagem foi enviada por nós (bot ou tela): ignora.
    const ja = checar(
      await this.db
        .from("salao_mensagens")
        .select("id")
        .eq("wamid", e.wamid)
        .limit(1),
    ) as unknown[];
    if (ja.length > 0) return;
    const conversa = checar(
      await this.db
        .from("salao_conversas")
        .upsert(
          {
            wa_id: e.para,
            bot_pausado: true,
            atualizado_em: new Date().toISOString(),
          },
          { onConflict: "wa_id" },
        )
        .select("id")
        .single(),
    ) as { id: string };
    checar(
      await this.db.from("salao_mensagens").upsert(
        {
          conversa_id: conversa.id,
          direcao: "saida",
          autor: "humano",
          wamid: e.wamid,
          tipo: e.tipo,
          texto: e.texto,
          status: "enviada_pelo_app",
          criado_em: e.enviadaEm.toISOString(),
        },
        { onConflict: "wamid", ignoreDuplicates: true },
      ),
    );
  }

  async ultimaEntradaWamid(conversaId: string): Promise<string | null> {
    const r = checar(
      await this.db
        .from("salao_mensagens")
        .select("wamid")
        .eq("conversa_id", conversaId)
        .eq("direcao", "entrada")
        .order("criado_em", { ascending: false })
        .limit(1),
    ) as { wamid: string | null }[];
    return r[0]?.wamid ?? null;
  }

  async historico(
    conversaId: string,
    limite: number,
  ): Promise<ItemHistorico[]> {
    const r = checar(
      await this.db
        .from("salao_mensagens")
        .select("autor, texto, tipo")
        .eq("conversa_id", conversaId)
        .order("criado_em", { ascending: false })
        .limit(limite),
    ) as {
      autor: ItemHistorico["autor"];
      texto: string | null;
      tipo: string;
    }[];
    return r
      .reverse()
      .map((m) => ({ autor: m.autor, texto: m.texto ?? `[${m.tipo}]` }));
  }

  async registrarSaida(
    conversaId: string,
    autor: "bot" | "humano",
    texto: string,
    envio: ResultadoEnvio,
  ): Promise<void> {
    checar(
      await this.db.from("salao_mensagens").insert({
        conversa_id: conversaId,
        direcao: "saida",
        autor,
        wamid: envio.wamid,
        tipo: "text",
        texto,
        status: envio.ok ? "aceita" : "erro_envio",
        erro: envio.ok ? null : { http: envio.httpStatus, erro: envio.erro },
      }),
    );
    checar(
      await this.db
        .from("salao_conversas")
        .update({ atualizado_em: new Date().toISOString() })
        .eq("id", conversaId),
    );
  }

  async marcarHumano(conversaId: string, motivo: string): Promise<void> {
    checar(
      await this.db
        .from("salao_conversas")
        .update({
          bot_pausado: true,
          precisa_humano: true,
          motivo_humano: motivo,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", conversaId),
    );
  }
}

/** Guarda a sessão anônima do Minha Agenda (tabela só do servidor). */
export class ArmazemSessaoSupabase implements ArmazemSessao {
  constructor(private db: SupabaseClient) {}

  async ler(): Promise<Sessao | null> {
    const r = checar(
      await this.db
        .from("salao_sessao_minhaagenda")
        .select("id_token, refresh_token, expira_em, cadastrado")
        .eq("id", 1)
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
        await this.db.from("salao_sessao_minhaagenda").delete().eq("id", 1),
      );
      return;
    }
    checar(
      await this.db.from("salao_sessao_minhaagenda").upsert({
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
  };
}

/** Propostas e agendamentos do bot (tabela salao_agendamentos). */
export class RepositorioPropostasSupabase implements RepositorioPropostas {
  constructor(private db: SupabaseClient) {}

  async criar(p: Omit<Proposta, "id" | "criadoEm">): Promise<Proposta> {
    checar(
      await this.db
        .from("salao_agendamentos")
        .update({
          status: "substituido",
          atualizado_em: new Date().toISOString(),
        })
        .eq("conversa_id", p.conversaId)
        .eq("status", "proposto"),
    );
    const r = checar(
      await this.db
        .from("salao_agendamentos")
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
          status: "proposto",
          expira_em: new Date(p.expiraEm).toISOString(),
        })
        .select("*")
        .single(),
    ) as LinhaAgendamento;
    return paraProposta(r);
  }

  async pendente(conversaId: string): Promise<Proposta | null> {
    const r = checar(
      await this.db
        .from("salao_agendamentos")
        .select("*")
        .eq("conversa_id", conversaId)
        .eq("status", "proposto")
        .order("criado_em", { ascending: false })
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
        .from("salao_agendamentos")
        .update({
          status: para,
          atualizado_em: new Date().toISOString(),
          ...(detalhe ? { detalhe } : {}),
        })
        .eq("id", id)
        .eq("status", de)
        .select("id"),
    ) as unknown[];
    return r.length > 0;
  }

  async agendadosDesde(conversaId: string, desde: Date): Promise<number> {
    const { count, error } = await this.db
      .from("salao_agendamentos")
      .select("id", { count: "exact", head: true })
      .eq("conversa_id", conversaId)
      .eq("status", "agendado")
      .gte("atualizado_em", desde.toISOString());
    if (error) throw error;
    return count ?? 0;
  }
}
