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
    "Confere se a vaga ainda está livre. NÃO agenda: devolve o resumo, o valor do sinal de 20% e a chave Pix para você mandar à cliente pedindo o comprovante.",
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

// ---------- regras puras ----------

export const PERCENTUAL_SINAL = 0.2;

/** Primeiro valor em reais de um preço em texto ("R$ 1.250,00", "A partir de R$ 60,00"). */
export function valorDoPreco(preco: string | null | undefined): number | null {
  const m = /(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})/.exec(preco ?? "");
  if (!m) return null;
  const v = Number(`${m[1].replace(/\./g, "")}.${m[2]}`);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function reais(v: number): string {
  return `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    aPartirDe: /a partir de/i.test(`${preco ?? ""} ${nome ?? ""}`),
  };
}

/** "2026-11-11" -> "quarta-feira, 11/11" */
export function dataCurta(data: string): string {
  const d = new Date(`${data}T12:00:00Z`);
  const dia = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    weekday: "long",
  }).format(d);
  const dm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
  return `${dia}, ${dm}`;
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

export interface PropostaRecente extends Proposta {
  status: string;
  atualizadoEm: number; // epoch ms
}

export interface RepositorioPropostas {
  /** Proposta mais recente da conversa, de qualquer status. */
  recente(conversaId: string): Promise<PropostaRecente | null>;
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
  servicos: Servico[];
}

export interface Pix {
  chave: string;
  titular: string;
}

export interface DepsFerramentas {
  consulta: Pick<ConsultaMinhaAgenda, "vagas">;
  agendador?: Pick<AgendadorMinhaAgenda, "agendar">; // ausente = só consulta
  propostas?: RepositorioPropostas;
  pix?: Pix; // ausente = não propõe agendamento (nada de sinal sem chave Pix)
  avisar: (assunto: string, texto: string) => Promise<void>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
  maxDias: number;
  agora?: () => Date;
}

export const VALIDADE_PROPOSTA_MS = 30 * 60_000;
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
    if (!deps.pix)
      return "o sinal por Pix ainda não está configurado: diga que a Bruna vai ajudar e marque passar_para_humano = true";
    const r = await agendaOuErro(servicoId, data, true);
    if (typeof r === "string") return r;
    const p = r.profissionais.find((x) => x.nome.toLowerCase() === prof);
    if (!p)
      return `profissional não encontrada para esse serviço nessa data. Opções: ${r.profissionais.map((x) => x.nome).join(", ") || "nenhuma"}`;
    if (!p.horarios.includes(hora)) {
      return `esse horário não está mais livre com ${p.nome}. ${agendaEmTexto(r)}`;
    }
    const s = servicoPorId.get(servicoId)!;
    const sinal = sinalDoServico(s.preco, s.nome);
    if (!sinal)
      return "não consigo calcular o sinal deste serviço: diga que a Bruna vai combinar o valor e marque passar_para_humano = true";
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
    deps.log("proposta_criada", {
      conversa: ctx.conversaId,
      proposta: proposta.id,
    });
    return (
      `Proposta registrada (vale 30 minutos): ${s.nome}, ${data} às ${hora} com ${p.nome}` +
      `${s.preco ? `, ${s.preco}` : ""}, no nome de ${nome}. ` +
      `Para confirmar, a cliente paga um sinal de 20% por Pix: ${sinal.texto}` +
      `${sinal.aPartirDe ? " (calculado sobre o valor mínimo; a Bruna confirma o valor final)" : ""}. ` +
      `Chave Pix: ${deps.pix.chave} (titular: ${deps.pix.titular}). ` +
      `Mande à cliente, num parágrafo só, o resumo do horário, o valor do sinal e a chave Pix, e peça o comprovante em imagem ou PDF aqui na conversa. ` +
      `O sistema agenda sozinho quando o comprovante chegar: você NÃO agenda e NUNCA diz que está agendado nem que o pagamento foi confirmado. Ainda NÃO está agendado.`
    );
  }

  const definicoes = podeAgendar
    ? [DEF_CONSULTAR, DEF_PROPOR]
    : [DEF_CONSULTAR];
  return {
    definicoes,
    executar(nome, entrada) {
      deps.log("ferramenta", { nome }); // só o nome, sem dados da cliente
      if (nome === "consultar_horarios") return consultar(entrada);
      if (podeAgendar && nome === "propor_agendamento") return propor(entrada);
      return Promise.resolve(`ferramenta desconhecida: ${nome}`);
    },
  };
}

// ---------- comprovante recebido: quem agenda é o código ----------

export type ResultadoComprovante =
  | { acao: "responder"; texto: string }
  | { acao: "humano"; texto: string; motivo: string }
  | { acao: "ignorar" };

export interface DepsComprovante {
  consulta: Pick<ConsultaMinhaAgenda, "vagas">;
  agendador: Pick<AgendadorMinhaAgenda, "agendar">;
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
      ? { acao: "ignorar" }
      : null;
  }
  const servico = proposta.servicoNome.replace(/\s*\(a partir de\)/i, "");
  const resumo = `${servico}, ${proposta.data} às ${proposta.hora} com ${proposta.profissionalNome}, no nome de ${proposta.nomeCliente} (+${ctx.waId})`;
  const chamarBruna = (texto: string, motivo: string): ResultadoComprovante => ({
    acao: "humano",
    texto,
    motivo: `${motivo}: ${resumo}. Confira o Pix e combine com a cliente.`,
  });

  if (proposta.expiraEm < agora().getTime()) {
    await deps.propostas.mudarStatus(proposta.id, "proposto", "expirado");
    return chamarBruna(
      "Recebi seu comprovante! 💖 Como o tempo da reserva acabou, vou chamar a Bruna para conferir o horário com você.",
      "comprovante recebido depois de a reserva vencer",
    );
  }
  const desde = new Date(agora().getTime() - 24 * 60 * 60_000);
  if (
    !deps.semLimiteDiario &&
    (await deps.propostas.agendadosDesde(ctx.conversaId, desde)) >= MAX_AGENDAMENTOS_DIA
  ) {
    return chamarBruna(
      "Recebi seu comprovante! 💖 Vou chamar a Bruna para te ajudar com esse novo horário.",
      "comprovante recebido, mas esta conversa já teve um agendamento hoje",
    );
  }
  if (!(await deps.propostas.mudarStatus(proposta.id, "proposto", "agendando"))) {
    return { acao: "ignorar" }; // outro comprovante já está sendo processado
  }
  try {
    const r = await deps.consulta.vagas(proposta.servicoId, proposta.data, true);
    const livre = r.profissionais
      .find((p) => p.id === proposta.profissionalId)
      ?.horarios.includes(proposta.hora);
    if (!livre) {
      await deps.propostas.mudarStatus(
        proposta.id,
        "agendando",
        "falhou",
        "horário ocupado antes do comprovante",
      );
      return chamarBruna(
        "Recebi seu comprovante, mas esse horário foi ocupado antes. 💖 A Bruna vai falar com você sobre o Pix e um novo horário.",
        "horário ocupado ao receber o comprovante",
      );
    }
    await deps.agendador.agendar({
      nome: proposta.nomeCliente,
      telefone: telefoneNacional(ctx.waId)!,
      profissionalId: proposta.profissionalId,
      servicoId: proposta.servicoId,
      data: proposta.data,
      hora: proposta.hora,
      comentario: "Agendado pelo assistente virtual do WhatsApp (sinal Pix)",
    });
  } catch (e) {
    await deps.propostas.mudarStatus(proposta.id, "agendando", "falhou", String(e));
    deps.log("erro_agendamento", { conversa: ctx.conversaId, erro: String(e) });
    return chamarBruna(
      "Recebi seu comprovante! 💖 Tive um problema para agendar aqui, então a Bruna vai finalizar com você.",
      "falha ao agendar depois do comprovante",
    );
  }
  await deps.propostas.mudarStatus(
    proposta.id,
    "agendando",
    "agendado",
    `comprovante recebido (${tipoMidia})`,
  );
  deps.log("agendado", { conversa: ctx.conversaId, proposta: proposta.id });
  const sinal = sinalDoServico(proposta.preco)?.texto ?? "20%";
  try {
    await deps.avisar(
      "IA do salão: novo agendamento pelo WhatsApp",
      `O assistente agendou no Minha Agenda depois de receber um comprovante (${tipoMidia === "document" ? "PDF" : "imagem"}) na conversa:\n\n${resumo}\n\n` +
        `Sinal combinado: ${sinal}. O sistema NÃO lê o comprovante: confira o Pix no banco e o comprovante no app do WhatsApp Business. Se não for válido, cancele o horário no Minha Agenda.\n`,
    );
  } catch (e) {
    deps.log("erro_aviso_agendamento", { erro: String(e) });
  }
  return {
    acao: "responder",
    texto: `Recebi seu comprovante, ${proposta.nomeCliente}! 💖 Seu horário de ${servico} está agendado para ${dataCurta(proposta.data)}, às ${proposta.hora}, com a ${proposta.profissionalNome}. A Bruna confere o Pix e, se precisar de algo, chama você por aqui.`,
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
  repo: Pick<RepositorioPropostas, "recente">,
  conversaId: string,
  agora: Date,
  esperar: (ms: number) => Promise<void>,
): Promise<string | null> {
  let r = await repo.recente(conversaId);
  for (let i = 0; r?.status === "agendando" && i < 5; i++) {
    await esperar(4000);
    r = await repo.recente(conversaId);
  }
  if (!r) return null;
  const servico = r.servicoNome.replace(/\s*\(a partir de\)/i, "");
  const resumo = `${servico}, ${r.data} às ${r.hora} com ${r.profissionalNome}, no nome de ${r.nomeCliente}`;
  if (r.status === "proposto" && r.expiraEm >= agora.getTime()) {
    return `Proposta pendente desta conversa, registrada pelo sistema, aguardando o comprovante do Pix e AINDA NÃO agendada: ${resumo}. Se a cliente perguntar ou disser que pagou, peça o comprovante (imagem ou PDF) aqui na conversa. Nunca diga que está agendado: o sistema agenda sozinho quando o comprovante chega.`;
  }
  if (
    r.status === "agendado" &&
    agora.getTime() - r.atualizadoEm <= JANELA_AGENDADO_RECENTE_MS
  ) {
    return `O sistema acabou de agendar (${resumo}) depois de receber o comprovante, e a mensagem de confirmação já foi enviada à cliente. Não repita a confirmação nem o resumo e não peça comprovante. Responda só se ela perguntar algo; se a mensagem for apenas um agradecimento ou um aviso de que mandou o comprovante, deixe "resposta" vazia.`;
  }
  return null;
}
