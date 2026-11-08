// Regras de decisão do bot. Sem dependência de banco ou rede direta:
// tudo entra por `DepsBot`, o que permite testar com dublês.

import type { MensagemRecebida, ResultadoEnvio } from "./whatsapp.ts";
import {
  camposFaltando,
  comInfoEspelhada,
  type DadosSalao,
  type Servico,
} from "./salao.ts";
import type { Atendente, ConfigIA, ItemHistorico } from "./llm.ts";
import type {
  ContextoConversa,
  Ferramentas,
  ResultadoComprovante,
} from "./agendamento.ts";

export interface Conversa {
  id: string;
  waId: string;
  nomePerfil: string | null;
  botPausado: boolean;
}

export interface Repositorio {
  /** Modelo, esforço e limites escolhidos no painel. */
  config(): Promise<ConfigIA>;
  conversa(id: string): Promise<Conversa>;
  historico(conversaId: string, limite: number): Promise<ItemHistorico[]>;
  ultimaEntradaWamid(conversaId: string): Promise<string | null>;
  temSaida(conversaId: string): Promise<boolean>;
  servicosAtivos(): Promise<Servico[]>;
  /** Horário e regras espelhados do Minha Agenda (tabela salao_info). */
  infoSalao(): Promise<Record<string, string>>;
  /** Quantas respostas o bot mandou desde `desde` (na conversa, ou em todas se conversaId = null). */
  respostasDoBot(conversaId: string | null, desde: Date): Promise<number>;
  registrarSaida(
    conversaId: string,
    autor: "bot" | "humano",
    texto: string,
    envio: ResultadoEnvio,
  ): Promise<void>;
  marcarHumano(conversaId: string, motivo: string): Promise<void>;
}

export interface DepsBot {
  repo: Repositorio;
  atendente: Atendente;
  salao: DadosSalao;
  enviar(para: string, texto: string): Promise<ResultadoEnvio>;
  /** Avisa a equipe (por e-mail) que uma conversa precisa de alguém. */
  avisar(conversa: Conversa, motivo: string): Promise<void>;
  esperar(ms: number): Promise<void>;
  /** Ferramentas do modelo (consultar/propor/confirmar). Ausente = desligadas. */
  ferramentas?: (ctx: ContextoConversa) => Ferramentas;
  /**
   * Imagem ou PDF recebido: se houver proposta pendente, agenda e devolve o que responder.
   * Devolve null quando não há proposta (o bot segue o caminho normal).
   */
  receberComprovante?: (
    conversa: Conversa,
    msg: MensagemRecebida,
  ) => Promise<ResultadoComprovante | null>;
  /** Texto da proposta de agendamento pendente da conversa (ou null). */
  propostaPendente?: (conversaId: string) => Promise<string | null>;
  /** Número entre 0 e 1 (Math.random). Injetável para os testes. */
  aleatorio?: () => number;
  log(evento: string, dados?: Record<string, unknown>): void;
}

export type Resultado =
  | "pausado"
  | "substituida_por_mais_recente"
  | "respondido"
  | "ignorado"
  | "passado_para_humano";

const TIPOS_TEXTO = new Set(["text", "button", "interactive"]);
const TIPOS_COMPROVANTE = new Set(["image", "document"]);
const PEDIDO_HUMANO =
  /\b(atendente|humano|humana|pessoa de verdade|falar com (a|o)? ?(dona|bruna|algu[eé]m))\b/i;
export const ESPERA_AGRUPAR_MS = 4000; // junta mensagens mandadas em sequência
const LIMITE_HISTORICO = 20;
// Proteção de custo: acima disso a conversa vai para humano sem chamar a LLM.
export const LIMITE_POR_CONVERSA_HORA = 20;
export const LIMITE_GLOBAL_DIA = 300;
const HORA_MS = 60 * 60 * 1000;

export function escolher<T>(
  opcoes: T[],
  aleatorio: () => number = Math.random,
): T {
  return opcoes[
    Math.min(opcoes.length - 1, Math.floor(aleatorio() * opcoes.length))
  ];
}

async function enviarComApresentacao(
  deps: DepsBot,
  c: Conversa,
  texto: string,
) {
  const primeira = !(await deps.repo.temSaida(c.id));
  const final = primeira
    ? `${escolher(deps.salao.mensagensApresentacao, deps.aleatorio)} ${texto}`
    : texto;
  const envio = await deps.enviar(c.waId, final);
  await deps.repo.registrarSaida(c.id, "bot", final, envio);
  return envio;
}

async function marcarEAvisar(deps: DepsBot, c: Conversa, motivo: string) {
  await deps.repo.marcarHumano(c.id, motivo);
  try {
    await deps.avisar(c, motivo);
  } catch (e) {
    deps.log("erro_aviso", { conversa: c.id, erro: String(e) });
  }
}

async function passarParaHumano(
  deps: DepsBot,
  c: Conversa,
  motivo: string,
): Promise<Resultado> {
  // Pausa antes de enviar: se o envio falhar, o bot já não volta a responder.
  await marcarEAvisar(deps, c, motivo);
  const envio = await enviarComApresentacao(
    deps,
    c,
    escolher(deps.salao.mensagensPassagemHumano, deps.aleatorio),
  );
  deps.log("passado_para_humano", {
    conversa: c.id,
    motivo,
    envio_ok: envio.ok,
  });
  return "passado_para_humano";
}

export async function processarMensagem(
  deps: DepsBot,
  conversaId: string,
  msg: MensagemRecebida,
): Promise<Resultado> {
  await deps.esperar(ESPERA_AGRUPAR_MS);

  const c = await deps.repo.conversa(conversaId);
  if (c.botPausado) return "pausado";

  // Comprovante de Pix (imagem ou PDF) de uma proposta pendente: o código agenda, sem IA.
  // Vem antes da checagem abaixo: se a cliente mandar outra mensagem logo depois, o
  // comprovante não pode se perder.
  if (TIPOS_COMPROVANTE.has(msg.tipo) && deps.receberComprovante) {
    let r: ResultadoComprovante | null;
    try {
      r = await deps.receberComprovante(c, msg);
    } catch (e) {
      deps.log("erro_comprovante", { conversa: c.id, erro: String(e) });
      return passarParaHumano(deps, c, "falha ao processar o comprovante");
    }
    if (r?.acao === "ignorar") return "ignorado";
    if (r?.acao === "responder") {
      const envio = await enviarComApresentacao(deps, c, r.texto);
      deps.log("comprovante_agendado", { conversa: c.id, envio_ok: envio.ok });
      return "respondido";
    }
    if (r?.acao === "humano") {
      await marcarEAvisar(deps, c, r.motivo);
      await enviarComApresentacao(deps, c, r.texto);
      return "passado_para_humano";
    }
  }

  // Se chegou outra mensagem depois desta, quem responde é o processamento dela.
  const ultima = await deps.repo.ultimaEntradaWamid(c.id);
  if (ultima && ultima !== msg.wamid) return "substituida_por_mais_recente";

  if (!TIPOS_TEXTO.has(msg.tipo) || !msg.texto?.trim()) {
    return passarParaHumano(
      deps,
      c,
      `mensagem do tipo "${msg.tipo}" (a IA só lê texto)`,
    );
  }
  if (PEDIDO_HUMANO.test(msg.texto)) {
    return passarParaHumano(deps, c, "cliente pediu atendimento humano");
  }
  const servicos = await deps.repo.servicosAtivos();
  const salao = comInfoEspelhada(deps.salao, await deps.repo.infoSalao());
  const faltando = camposFaltando(salao, servicos);
  if (faltando.length > 0) {
    return passarParaHumano(
      deps,
      c,
      `dados do salão incompletos: ${faltando.join(", ")}`,
    );
  }

  const cfg = await deps.repo.config();
  const agora = Date.now();
  if (
    (await deps.repo.respostasDoBot(c.id, new Date(agora - HORA_MS))) >=
    cfg.limiteConversaHora
  ) {
    return passarParaHumano(
      deps,
      c,
      `limite de ${cfg.limiteConversaHora} respostas automáticas por hora nesta conversa`,
    );
  }
  if (
    (await deps.repo.respostasDoBot(null, new Date(agora - 24 * HORA_MS))) >=
    cfg.limiteGlobalDia
  ) {
    return passarParaHumano(
      deps,
      c,
      `limite diário de ${cfg.limiteGlobalDia} respostas automáticas atingido`,
    );
  }

  let decisao;
  try {
    const historico = await deps.repo.historico(c.id, LIMITE_HISTORICO);
    const propostaPendente = await deps.propostaPendente?.(c.id).catch(() => null);
    decisao = await deps.atendente.responder(historico, servicos, salao, {
      ferramentas: deps.ferramentas?.({
        conversaId: c.id,
        waId: c.waId,
        servicos,
      }),
      nomeCliente: c.nomePerfil,
      propostaPendente,
      modelo: cfg.modelo,
      esforco: cfg.esforco,
    });
  } catch (e) {
    deps.log("erro_llm", { conversa: c.id, erro: String(e) });
    return passarParaHumano(deps, c, "falha ao gerar resposta automática");
  }

  // Confere de novo: alguém pode ter pausado enquanto a LLM respondia.
  if ((await deps.repo.conversa(c.id)).botPausado) return "pausado";

  if (decisao.passar_para_humano) {
    await marcarEAvisar(deps, c, decisao.motivo || "decisão da IA");
  }
  const texto =
    decisao.resposta.trim() ||
    escolher(deps.salao.mensagensPassagemHumano, deps.aleatorio);
  const envio = await enviarComApresentacao(deps, c, texto);
  deps.log("respondido", {
    conversa: c.id,
    intencao: decisao.intencao,
    humano: decisao.passar_para_humano,
    envio_ok: envio.ok,
  });
  return decisao.passar_para_humano ? "passado_para_humano" : "respondido";
}
