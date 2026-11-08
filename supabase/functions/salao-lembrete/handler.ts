// Lembrete do comprovante do Pix. Chamada a cada minuto pelo pg_cron (ver migration).
// Não exige JWT: só envia lembretes que já venceram, no máximo 4 por proposta
// (o contador é gravado antes de enviar), então chamadas extras não geram mensagens extras.

import { enviarLembretes } from "../_shared/lembrete.ts";
import {
  clienteServico,
  exigirEnv,
  LembretesSupabase,
  RepositorioSupabase,
} from "../_shared/db.ts";
import { enviarTexto, type ConfigWhatsApp } from "../_shared/whatsapp.ts";

function log(evento: string, dados: Record<string, unknown> = {}) {
  // Sem texto de mensagem no log (LGPD).
  console.log(JSON.stringify({ evento, ...dados }));
}

export async function tratar(req: Request): Promise<Response> {
  if (req.method !== "POST")
    return new Response("method not allowed", { status: 405 });
  const wa: ConfigWhatsApp = {
    token: exigirEnv("SALAO_WHATSAPP_TOKEN"),
    phoneNumberId: exigirEnv("SALAO_WHATSAPP_PHONE_NUMBER_ID"),
    graphApiVersion: exigirEnv("SALAO_GRAPH_API_VERSION"),
  };
  const db = clienteServico();
  const repo = new RepositorioSupabase(db);
  const enviados = await enviarLembretes({
    repo: new LembretesSupabase(db),
    enviar: (para, texto) => enviarTexto(wa, para, texto),
    registrarSaida: (conversaId, texto, envio) =>
      repo.registrarSaida(conversaId, "bot", texto, envio),
    log,
  });
  return new Response(JSON.stringify({ enviados }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
