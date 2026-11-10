// Escolhe o provedor de IA. Só o Anthropic existe hoje; o padrão não muda nada.
// Para trocar: SALAO_LLM_PROVEDOR=<nome> (secret do Supabase) e um novo caso abaixo.

import type { Atendente } from './llm.ts';
import { AtendenteClaude } from './llm_claude.ts';

export const PROVEDOR_PADRAO = 'anthropic';

export function criarAtendente(env: (nome: string) => string | undefined): Atendente {
  const provedor = (env('SALAO_LLM_PROVEDOR') || PROVEDOR_PADRAO).toLowerCase();
  switch (provedor) {
    case 'anthropic': {
      const chave = env('SALAO_ANTHROPIC_API_KEY');
      if (!chave) throw new Error('Falta o secret SALAO_ANTHROPIC_API_KEY');
      return new AtendenteClaude(chave);
    }
    default:
      throw new Error(`Provedor de IA desconhecido: ${provedor}`);
  }
}
