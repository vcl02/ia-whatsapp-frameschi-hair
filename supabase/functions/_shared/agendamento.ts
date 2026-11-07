// Agendamento pelo bot no Minha Agenda, sempre em duas etapas:
//  1. propor_agendamento: confere a vaga e grava uma PROPOSTA (vale 10 min);
//  2. confirmar_agendamento: só agenda se existir proposta pendente desta
//     conversa E a última mensagem da cliente for uma confirmação ("sim"...).
// A trava está aqui no código; a instrução ao modelo é só um reforço.
//
// O agendamento é feito com um cadastro de convidada no nome e telefone da
// própria cliente (como se ela agendasse pelo site), depois da confirmação dela.

import {
  agendaEmTexto,
  API,
  cabecalhosApi,
  cadastrarConvidada,
  ConsultaMinhaAgenda,
  loginAnonimo,
  validarData,
  type Agenda,
} from "./disponibilidade.ts";
import type { Servico } from "./salao.ts";

// ---------- ferramentas que o modelo vê ----------

export interface DefinicaoFerramenta {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: "object";
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
  name: "consultar_horarios",
  description:
    "Consulta os horários livres de UM serviço numa data, por profissional. " +
    "Use quando a cliente perguntar se tem horário/vaga num dia.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      servico_id: {
        type: "integer",
        description:
          "id do serviço, como aparece entre colchetes na lista de serviços",
      },
      data: { type: "string", description: "data no formato AAAA-MM-DD" },
    },
    required: ["servico_id", "data"],
    additionalProperties: false,
  },
};

export const DEF_PROPOR: DefinicaoFerramenta = {
  name: "propor_agendamento",
  description:
    "Registra uma proposta de agendamento depois que a cliente escolheu serviço, dia, horário e profissional. " +
    "Confere se a vaga ainda está livre. NÃO agenda: devolve um resumo para você mandar à cliente pedindo confirmação.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      servico_id: { type: "integer", description: "id do serviço da lista" },
      data: { type: "string", description: "AAAA-MM-DD" },
      hora: {
        type: "string",
        description:
          "horário de início, HH:MM, exatamente como veio da consulta",
      },
      profissional: {
        type: "string",
        description: "primeiro nome da profissional, como veio da consulta",
      },
      nome_cliente: {
        type: "string",
        description: "nome da cliente para a agenda",
      },
    },
    required: ["servico_id", "data", "hora", "profissional", "nome_cliente"],
    additionalProperties: false,
  },
};

export const DEF_CONFIRMAR: DefinicaoFerramenta = {
  name: "confirmar_agendamento",
  description:
    "Agenda de verdade a proposta pendente desta conversa. Use SOMENTE quando a última mensagem da cliente " +
    'confirmar o resumo da proposta (ex.: "sim", "pode", "confirmo").',
  strict: true,
  input_schema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

// ---------- regras puras ----------

const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** A mensagem da cliente é uma confirmação clara? (trava do agendamento) */
export function ehConfirmacao(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const t = semAcento(texto)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s👍✅]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !t ||
    /\b(nao|n|nem|espera|perai|pera|cancela|depois|mas|ou|outro|outra|troca|trocar|muda|mudar|prefiro)\b/.test(
      t,
    )
  )
    return false;
  // Número na mensagem = cliente ainda escolhendo horário/dia ("quero às 9"), não confirmando.
  if (/\d/.test(t)) return false;
  return /^(sim|s|ss|sim sim|isso|isso mesmo|pode|pode sim|pode ser|pode marcar|pode agendar|confirmo|confirmado|confirma|ok|okay|beleza|blz|claro|fechado|combinado|perfeito|👍|✅)(?=\s|$)/u.test(
    t,
  );
}

/** wa_id brasileiro (5511999998888) -> telefone nacional (11999998888). Outros países: null. */
export function telefoneNacional(waId: string): string | null {
  const d = waId.replace(/\D/g, "");
  return d.startsWith("55") && (d.length === 12 || d.length === 13)
    ? d.slice(2)
    : null;
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
}

export interface RepositorioPropostas {
  /** Grava a proposta e marca como "substituido" qualquer proposta pendente anterior da conversa. */
  criar(p: Omit<Proposta, "id" | "criadoEm">): Promise<Proposta>;
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
      { name: p.nome, phone: p.telefone, countryIso: "BR" },
      this.fetchFn,
    );
    const r = await this.fetchFn(`${API}/currentUser/appointments`, {
      method: "POST",
      headers: {
        ...cabecalhosApi(sessao.idToken),
        "content-type": "application/json",
        origin: "https://online.maapp.com.br",
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
    if (!r.ok || j.status !== "CREATED") {
      throw new Error(
        `Minha Agenda não criou o agendamento (HTTP ${r.status}, status ${String(j.status ?? "-")})`,
      );
    }
  }
}

// ---------- montagem das ferramentas de uma conversa ----------

export interface ContextoConversa {
  conversaId: string;
  waId: string;
  ultimaMensagem: string | null;
  ultimaMensagemEm: Date; // quando a última mensagem da cliente chegou
  servicos: Servico[];
}

export interface DepsFerramentas {
  consulta: Pick<ConsultaMinhaAgenda, "vagas">;
  agendador?: Pick<AgendadorMinhaAgenda, "agendar">; // ausente = só consulta
  propostas?: RepositorioPropostas;
  avisar: (assunto: string, texto: string) => Promise<void>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
  maxDias: number;
  agora?: () => Date;
}

const VALIDADE_PROPOSTA_MS = 10 * 60_000;
const MAX_AGENDAMENTOS_DIA = 1;

export function montarFerramentas(
  ctx: ContextoConversa,
  deps: DepsFerramentas,
): Ferramentas {
  const agora = deps.agora ?? (() => new Date());
  const servicoPorId = new Map(
    ctx.servicos.flatMap((s) =>
      s.origem_id ? [[s.origem_id, s] as const] : [],
    ),
  );
  const podeAgendar = !!(deps.agendador && deps.propostas);
  let propostaNestaResposta = false;

  async function agendaOuErro(
    servicoId: number,
    data: string,
    semCache = false,
  ): Promise<Agenda | string> {
    if (!servicoPorId.has(servicoId))
      return "serviço não encontrado na lista: confirme com a cliente qual serviço ela quer";
    const erro = validarData(data, deps.maxDias, agora());
    if (erro) return erro;
    try {
      return await deps.consulta.vagas(servicoId, data, semCache);
    } catch (e) {
      deps.log("erro_consulta_horarios", { erro: String(e) });
      return "não foi possível consultar a agenda agora: mande o link de agendamento para a cliente";
    }
  }

  async function consultar(e: Record<string, unknown>): Promise<string> {
    const r = await agendaOuErro(Number(e.servico_id), String(e.data ?? ""));
    return typeof r === "string" ? r : agendaEmTexto(r);
  }

  async function propor(e: Record<string, unknown>): Promise<string> {
    const servicoId = Number(e.servico_id);
    const data = String(e.data ?? "");
    const hora = String(e.hora ?? "");
    const nome = String(e.nome_cliente ?? "").trim();
    const prof = String(e.profissional ?? "")
      .trim()
      .toLowerCase();
    if (!HORA_RE.test(hora))
      return "horário inválido: use HH:MM, como veio da consulta";
    if (!nome)
      return "falta o nome da cliente: pergunte como ela quer ser chamada na agenda";
    if (!telefoneNacional(ctx.waId))
      return "não consigo agendar para número de fora do Brasil: mande o link de agendamento";
    const r = await agendaOuErro(servicoId, data, true);
    if (typeof r === "string") return r;
    const p = r.profissionais.find((x) => x.nome.toLowerCase() === prof);
    if (!p)
      return `profissional não encontrada para esse serviço nessa data. Opções: ${r.profissionais.map((x) => x.nome).join(", ") || "nenhuma"}`;
    if (!p.horarios.includes(hora)) {
      return `esse horário não está mais livre com ${p.nome}. ${agendaEmTexto(r)}`;
    }
    const s = servicoPorId.get(servicoId)!;
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
    propostaNestaResposta = true;
    deps.log("proposta_criada", {
      conversa: ctx.conversaId,
      proposta: proposta.id,
    });
    return (
      `Proposta registrada (vale 10 minutos): ${s.nome}, ${data} às ${hora} com ${p.nome}` +
      `${s.preco ? `, ${s.preco}` : ""}, no nome de ${nome}. Mande esse resumo para a cliente e peça para ela responder SIM para confirmar. ` +
      `Ainda NÃO está agendado.`
    );
  }

  async function confirmar(): Promise<string> {
    // TRAVA: a cliente precisa ter VISTO o resumo. Proposta feita nesta mesma resposta,
    // ou depois da última mensagem dela, ainda não foi mostrada.
    if (propostaNestaResposta) {
      return "a cliente ainda não viu o resumo: mande o resumo e peça para ela responder SIM. Nada foi agendado.";
    }
    const proposta = await deps.propostas!.pendente(ctx.conversaId);
    if (!proposta)
      return "não há proposta pendente: confirme com a cliente serviço, dia e horário e use propor_agendamento";
    if (proposta.expiraEm < agora().getTime()) {
      await deps.propostas!.mudarStatus(proposta.id, "proposto", "expirado");
      return "a proposta expirou: consulte de novo e faça uma nova proposta";
    }
    if (proposta.criadoEm >= ctx.ultimaMensagemEm.getTime()) {
      return "a cliente ainda não respondeu ao resumo: mande o resumo e peça para ela responder SIM. Nada foi agendado.";
    }
    if (!ehConfirmacao(ctx.ultimaMensagem)) {
      return "a última mensagem da cliente não é uma confirmação clara: peça para ela responder SIM ao resumo. Nada foi agendado.";
    }
    const desde = new Date(agora().getTime() - 24 * 60 * 60_000);
    if (
      (await deps.propostas!.agendadosDesde(ctx.conversaId, desde)) >=
      MAX_AGENDAMENTOS_DIA
    ) {
      return "esta conversa já teve um agendamento pelo assistente hoje: não agende de novo; diga que a Bruna vai ajudar e marque passar_para_humano = true";
    }
    if (
      !(await deps.propostas!.mudarStatus(proposta.id, "proposto", "agendando"))
    ) {
      return "essa proposta já está sendo processada: não repita";
    }
    try {
      const r = await deps.consulta.vagas(
        proposta.servicoId,
        proposta.data,
        true,
      );
      const livre = r.profissionais
        .find((p) => p.id === proposta.profissionalId)
        ?.horarios.includes(proposta.hora);
      if (!livre) {
        await deps.propostas!.mudarStatus(
          proposta.id,
          "agendando",
          "falhou",
          "horário ocupado antes da confirmação",
        );
        return `o horário foi ocupado antes da confirmação. ${agendaEmTexto(r)} Ofereça outro horário. Nada foi agendado.`;
      }
      await deps.agendador!.agendar({
        nome: proposta.nomeCliente,
        telefone: telefoneNacional(ctx.waId)!,
        profissionalId: proposta.profissionalId,
        servicoId: proposta.servicoId,
        data: proposta.data,
        hora: proposta.hora,
        comentario: "Agendado pelo assistente virtual do WhatsApp",
      });
    } catch (e) {
      await deps.propostas!.mudarStatus(
        proposta.id,
        "agendando",
        "falhou",
        String(e),
      );
      deps.log("erro_agendamento", {
        conversa: ctx.conversaId,
        erro: String(e),
      });
      return "o agendamento falhou no sistema: mande o link de agendamento, diga que a Bruna vai ajudar e marque passar_para_humano = true. Nada foi agendado.";
    }
    await deps.propostas!.mudarStatus(proposta.id, "agendando", "agendado");
    deps.log("agendado", { conversa: ctx.conversaId, proposta: proposta.id });
    const resumo = `${proposta.servicoNome}, ${proposta.data} às ${proposta.hora} com ${proposta.profissionalNome}, no nome de ${proposta.nomeCliente} (+${ctx.waId})`;
    try {
      await deps.avisar(
        "Bot do salão: novo agendamento pelo WhatsApp",
        `O assistente agendou no Minha Agenda:\n\n${resumo}\n`,
      );
    } catch (e) {
      deps.log("erro_aviso_agendamento", { erro: String(e) });
    }
    return `AGENDADO com sucesso: ${resumo}. Confirme para a cliente com carinho e lembre das regras (tolerância de atraso, cancelamento).`;
  }

  const definicoes = podeAgendar
    ? [DEF_CONSULTAR, DEF_PROPOR, DEF_CONFIRMAR]
    : [DEF_CONSULTAR];
  return {
    definicoes,
    executar(nome, entrada) {
      if (nome === "consultar_horarios") return consultar(entrada);
      if (podeAgendar && nome === "propor_agendamento") return propor(entrada);
      if (podeAgendar && nome === "confirmar_agendamento") return confirmar();
      return Promise.resolve(`ferramenta desconhecida: ${nome}`);
    },
  };
}
