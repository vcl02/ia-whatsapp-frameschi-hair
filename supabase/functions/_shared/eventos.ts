// Registro de erros na tabela salao_eventos (aparecem no painel). Sem texto de
// mensagem de cliente (LGPD): só o tipo e dados técnicos curtos.

import type { SupabaseClient } from './deps.ts';

/** Tipos de evento que contam como erro (painel e alerta por e-mail). */
export const EVENTO_DE_ERRO = /^(erro_|status_falha)/;

export async function registrarEvento(
  db: SupabaseClient,
  tipo: string,
  dados: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from('salao_eventos')
    .insert({ tipo, detalhe: JSON.stringify(dados).slice(0, 500) });
  if (error) throw error;
}
