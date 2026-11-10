// Provedor Anthropic (Claude) para o `Atendente`.
// A chave fica só no secret SALAO_ANTHROPIC_API_KEY do Supabase.
// Para outro provedor, crie um arquivo irmão que implemente `Atendente` e registre-o em atendente.ts.

import { Anthropic } from './deps.ts';
import type { DadosSalao, Servico } from './salao.ts';
import {
  type Atendente,
  AVISO_ULTIMA_RODADA,
  blocoContexto,
  type DecisaoLLM,
  FalhaLLM,
  type ItemHistorico,
  MAX_RODADAS_FERRAMENTA,
  MODELO,
  montarMensagens,
  montarSistema,
  type OpcoesResposta,
  SCHEMA,
  type UsoTokens,
  validarDecisao,
} from './llm.ts';

/** Só o pedaço do SDK que usamos (permite cliente falso nos testes). */
export interface ClienteMensagens {
  beta: {
    messages: {
      create(
        p: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      ): Promise<Anthropic.Beta.Messages.BetaMessage>;
    };
  };
}

export class AtendenteClaude implements Atendente {
  private client: ClienteMensagens;
  constructor(
    apiKey: string,
    private relogio: () => Date = () => new Date(),
    cliente?: ClienteMensagens,
  ) {
    this.client = cliente ?? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  }

  async responder(
    historico: ItemHistorico[],
    servicos: Servico[],
    salao: DadosSalao,
    opcoes: OpcoesResposta = {},
  ): Promise<DecisaoLLM> {
    const {
      ferramentas,
      nomeCliente,
      modelo,
      esforco,
      contextoAgendamento,
      aprendizados,
    } = opcoes;
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = montarMensagens(
      historico,
    );
    if (messages.length === 0) {
      throw new FalhaLLM('histórico sem mensagem da cliente');
    }
    // Parte fixa primeiro (com cache) e o contexto que muda (hora, nome) por último.
    const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
      {
        type: 'text',
        text: montarSistema(salao, servicos, aprendizados),
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: blocoContexto(
          this.relogio(),
          nomeCliente,
          contextoAgendamento,
          aprendizados,
        ),
      },
    ];
    const uso: UsoTokens = { entrada: 0, saida: 0, cache: 0 };
    for (let rodada = 0; rodada <= MAX_RODADAS_FERRAMENTA; rodada++) {
      // Na última chamada o modelo não pode mais usar ferramentas: tem que responder.
      const ultima = rodada === MAX_RODADAS_FERRAMENTA;
      const resp = await this.client.beta.messages.create({
        model: modelo ?? MODELO,
        max_tokens: 4096,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // se o modelo recusar, a API tenta outro modelo
        output_config: {
          effort: esforco ?? 'medium',
          format: { type: 'json_schema', schema: SCHEMA },
        },
        ...(ferramentas?.definicoes.length ? { tools: ferramentas.definicoes } : {}),
        ...(ultima && ferramentas?.definicoes.length
          ? { tool_choice: { type: 'none' as const } }
          : {}),
        system,
        messages,
      });
      uso.entrada += resp.usage?.input_tokens ?? 0;
      uso.saida += resp.usage?.output_tokens ?? 0;
      uso.cache += resp.usage?.cache_read_input_tokens ?? 0;
      if (
        resp.stop_reason === 'tool_use' &&
        ferramentas &&
        rodada < MAX_RODADAS_FERRAMENTA
      ) {
        const resultados: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const bloco of resp.content) {
          if (bloco.type !== 'tool_use') continue;
          const entrada = (
            bloco.input && typeof bloco.input === 'object' ? bloco.input : {}
          ) as Record<string, unknown>;
          const conteudo = await ferramentas.executar(bloco.name, entrada);
          resultados.push({
            type: 'tool_result',
            tool_use_id: bloco.id,
            content: conteudo,
          });
        }
        // Devolve o turno do modelo sem alterar (inclui blocos de raciocínio) + os resultados.
        messages.push(
          { role: 'assistant', content: resp.content },
          {
            role: 'user',
            content: rodada + 1 === MAX_RODADAS_FERRAMENTA
              ? [...resultados, { type: 'text', text: AVISO_ULTIMA_RODADA }]
              : resultados,
          },
        );
        continue;
      }
      return { ...interpretar(resp), uso };
    }
    throw new FalhaLLM('chamadas de ferramenta demais numa resposta');
  }
}

function interpretar(resp: Anthropic.Beta.Messages.BetaMessage): DecisaoLLM {
  if (resp.stop_reason !== 'end_turn') {
    throw new FalhaLLM(`stop_reason=${resp.stop_reason}`);
  }
  const texto = resp.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new FalhaLLM('resposta não é JSON');
  }
  const decisao = validarDecisao(json);
  if (!decisao) throw new FalhaLLM('JSON fora do formato');
  return decisao;
}
