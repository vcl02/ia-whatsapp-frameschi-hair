// Resposta manual pela tela de conversas. Exige usuário logado no Supabase Auth e cadastrado em `salao_equipe`. Ao responder, o bot da conversa é pausado (a pessoa assumiu).

import {
  clienteServico,
  exigirEnv,
  RepositorioSupabase,
} from "../_shared/db.ts";
import { dentroDaJanela, enviarTexto } from "../_shared/whatsapp.ts";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SALAO_PAINEL_ORIGEM") ?? "null",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, corpo: unknown) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export async function tratar(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { erro: "método não permitido" });

  const jwt = (req.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!jwt) return json(401, { erro: "não autenticado" });
  const db = clienteServico();
  const { data: u } = await db.auth.getUser(jwt);
  if (!u?.user) return json(401, { erro: "não autenticado" });

  const { data: membro } = await db
    .from("salao_equipe")
    .select("user_id")
    .eq("user_id", u.user.id)
    .maybeSingle();
  if (!membro) return json(403, { erro: "usuário fora da equipe" });

  const body = (await req.json().catch(() => null)) as {
    conversa_id?: string;
    texto?: string;
  } | null;
  const texto = body?.texto?.trim();
  if (!body?.conversa_id || !texto)
    return json(400, { erro: "conversa_id e texto são obrigatórios" });
  if (texto.length > 4096) return json(400, { erro: "texto longo demais" });

  const { data: conversa } = await db
    .from("salao_conversas")
    .select("id, wa_id, ultimo_inbound_em")
    .eq("id", body.conversa_id)
    .maybeSingle();
  if (!conversa) return json(404, { erro: "conversa não encontrada" });

  const ultimo = conversa.ultimo_inbound_em
    ? new Date(conversa.ultimo_inbound_em)
    : null;
  if (!dentroDaJanela(ultimo)) {
    return json(409, {
      erro: "fora da janela de 24 h: texto livre não é entregue. É preciso um modelo aprovado (ainda não implementado).",
    });
  }

  // Pausa antes de enviar, para o bot não responder por cima.
  await db
    .from("salao_conversas")
    .update({ bot_pausado: true })
    .eq("id", conversa.id);

  const envio = await enviarTexto(
    {
      token: exigirEnv("SALAO_WHATSAPP_TOKEN"),
      phoneNumberId: exigirEnv("SALAO_WHATSAPP_PHONE_NUMBER_ID"),
      graphApiVersion: exigirEnv("SALAO_GRAPH_API_VERSION"),
    },
    conversa.wa_id,
    texto,
  );

  await new RepositorioSupabase(db).registrarSaida(
    conversa.id,
    "humano",
    texto,
    envio,
  );
  return envio.ok
    ? json(200, { ok: true, wamid: envio.wamid })
    : json(502, { erro: "a Meta recusou o envio", detalhe: envio.erro });
}
