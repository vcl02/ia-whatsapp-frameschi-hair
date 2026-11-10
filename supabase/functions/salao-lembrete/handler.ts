// Lembrete do comprovante do Pix. Chamada a cada minuto pelo pg_cron (ver migration).
// Não exige JWT: só envia lembretes que já venceram, no máximo 4 por proposta
// (o contador é gravado antes de enviar), então chamadas extras não geram mensagens extras.
// Depois dos lembretes, manda o alerta de erros (no máximo 1 e-mail por hora).

import { enviarLembretes } from "../_shared/lembrete.ts";
import {
  clienteServico,
  exigirEnv,
  LembretesSupabase,
  RepositorioSupabase,
} from "../_shared/db.ts";
import { enviarTexto, type ConfigWhatsApp } from "../_shared/whatsapp.ts";
import { EVENTO_DE_ERRO, registrarEvento } from "../_shared/eventos.ts";
import { AlertasSupabase, enviarAlertaDeErros } from "../_shared/alertas.ts";
import {
  enviarEmailResend,
  enviarResumo,
  lerConfigAviso,
} from "../_shared/aviso.ts";

function log(evento: string, dados: Record<string, unknown> = {}) {
  // Sem texto de mensagem no log (LGPD).
  console.log(JSON.stringify({ evento, ...dados }));
}

async function tratarInterno(req: Request): Promise<Response> {
  if (req.method !== "POST")
    return new Response("method not allowed", { status: 405 });
  const wa: ConfigWhatsApp = {
    token: exigirEnv("SALAO_WHATSAPP_TOKEN"),
    phoneNumberId: exigirEnv("SALAO_WHATSAPP_PHONE_NUMBER_ID"),
    graphApiVersion: exigirEnv("SALAO_GRAPH_API_VERSION"),
  };
  const db = clienteServico();
  const repo = new RepositorioSupabase(db);
  // Erros também vão para o painel (salao_eventos).
  const gravacoes: Promise<unknown>[] = [];
  const logar = (evento: string, dados: Record<string, unknown> = {}) => {
    log(evento, dados);
    if (EVENTO_DE_ERRO.test(evento))
      gravacoes.push(
        registrarEvento(db, evento, dados).catch((e) =>
          log("falha_gravar_evento", { erro: String(e) }),
        ),
      );
  };
  const enviados = await enviarLembretes({
    repo: new LembretesSupabase(db),
    enviar: (para, texto) => enviarTexto(wa, para, texto),
    registrarSaida: (conversaId, texto, envio) =>
      repo.registrarSaida(conversaId, "bot", texto, envio),
    log: logar,
  });
  await Promise.all(gravacoes);

  // O alerta nunca pode atrapalhar os lembretes.
  try {
    const aviso = lerConfigAviso((n) => Deno.env.get(n));
    await enviarAlertaDeErros({
      repo: new AlertasSupabase(db),
      enviar: (assunto, texto) =>
        enviarResumo(aviso, { enviarEmail: enviarEmailResend, log }, assunto, texto),
      log,
    });
  } catch (e) {
    log("falha_alerta_erros", { erro: String(e) });
  }
  return new Response(JSON.stringify({ enviados }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function tratar(req: Request): Promise<Response> {
  try {
    return await tratarInterno(req);
  } catch (e) {
    log("erro_funcao_lembrete", { erro: String(e) });
    try {
      await registrarEvento(clienteServico(), "erro_funcao_lembrete", {
        erro: String(e),
      });
    } catch { /* sem banco ou sem env: o log acima já registrou */ }
    throw e;
  }
}
