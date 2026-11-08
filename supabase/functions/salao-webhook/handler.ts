// Webhook da WhatsApp Cloud API (bot do salão).
// GET  -> verificação (hub.challenge)
// POST -> valida X-Hub-Signature-256, grava mensagens, ecos e statuses, responde 200 e processa a resposta do bot em segundo plano.

import { assinaturaValida } from "../_shared/assinatura.ts";
import {
  enviarTexto,
  filtrarPorListas,
  lerEventos,
  type ConfigWhatsApp,
} from "../_shared/whatsapp.ts";
import {
  ArmazemSessaoSupabase,
  clienteServico,
  exigirEnv,
  RepositorioPropostasSupabase,
  RepositorioSupabase,
} from "../_shared/db.ts";
import { ConsultaMinhaAgenda } from "../_shared/disponibilidade.ts";
import {
  AgendadorMinhaAgenda,
  montarFerramentas,
} from "../_shared/agendamento.ts";
import { processarMensagem, type DepsBot } from "../_shared/bot.ts";
import {
  avisarEquipe,
  enviarEmailResend,
  enviarResumo,
  lerConfigAviso,
} from "../_shared/aviso.ts";
import { AtendenteClaude } from "../_shared/llm.ts";
import { SALAO } from "../_shared/salao.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function log(evento: string, dados: Record<string, unknown> = {}) {
  // Sem texto de mensagem no log (LGPD).
  console.log(JSON.stringify({ evento, ...dados }));
}

// Eventos de erro vão também para o painel (tabela salao_eventos), sem texto de mensagem.
const EVENTO_DE_ERRO = /^(erro_|status_falha)/;

function emSegundoPlano(p: Promise<unknown>) {
  const seguro = p.catch((e) => log("erro_segundo_plano", { erro: String(e) }));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(seguro);
  return seguro;
}

export async function tratar(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok =
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") ===
        exigirEnv("SALAO_WHATSAPP_VERIFY_TOKEN");
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", {
          status: 200,
        })
      : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST")
    return new Response("method not allowed", { status: 405 });

  const corpo = new Uint8Array(await req.arrayBuffer());
  const valida = await assinaturaValida(
    corpo,
    req.headers.get("x-hub-signature-256"),
    exigirEnv("SALAO_META_APP_SECRET"),
  );
  if (!valida) {
    log("assinatura_invalida");
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(corpo));
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const wa: ConfigWhatsApp = {
    token: exigirEnv("SALAO_WHATSAPP_TOKEN"),
    phoneNumberId: exigirEnv("SALAO_WHATSAPP_PHONE_NUMBER_ID"),
    graphApiVersion: exigirEnv("SALAO_GRAPH_API_VERSION"),
  };
  const db = clienteServico();
  const repo = new RepositorioSupabase(db);
  // Quem a IA atende vem das listas do painel (teste e familiares); quem ela não
  // atende não é gravado nem respondido. Sem conseguir ler as listas, nada é respondido.
  const listas = await repo.listasNumeros();
  const { eventos, descartados } = filtrarPorListas(
    lerEventos(payload, wa.phoneNumberId),
    listas,
  );
  const iaLigadaParaNovas = await repo.iaAtiva();
  const logar = (evento: string, dados: Record<string, unknown> = {}) => {
    log(evento, dados);
    if (!EVENTO_DE_ERRO.test(evento)) return;
    emSegundoPlano(
      Promise.resolve(
        db
          .from("salao_eventos")
          .insert({ tipo: evento, detalhe: JSON.stringify(dados).slice(0, 500) }),
      ).then(({ error }) => {
        if (error) log("falha_gravar_evento", { erro: String(error.message) });
      }),
    );
  };
  // Consulta e agendamento no Minha Agenda: só ligam com a chave do Firebase configurada.
  // O agendamento pode ser desligado à parte com SALAO_AGENDAR=nao.
  const chaveFirebase = Deno.env.get("SALAO_MA_FIREBASE_KEY");
  const consulta = chaveFirebase
    ? new ConsultaMinhaAgenda(chaveFirebase, new ArmazemSessaoSupabase(db))
    : null;
  const agendarLigado =
    !!chaveFirebase && Deno.env.get("SALAO_AGENDAR") !== "nao";
  const aviso = lerConfigAviso((n) => Deno.env.get(n));

  for (const s of eventos.statuses) {
    await repo.registrarStatus(s);
    if (s.status === "failed")
      logar("status_falha", { wamid: s.wamid, erros: s.erros });
  }
  for (const e of eventos.ecos)
    await repo.registrarEco(e, listas.teste.has(e.para));

  const deps: DepsBot = {
    repo,
    atendente: new AtendenteClaude(exigirEnv("SALAO_ANTHROPIC_API_KEY")),
    salao: SALAO,
    enviar: (para, texto) => enviarTexto(wa, para, texto),
    avisar: (c, motivo) =>
      avisarEquipe(
        aviso,
        { enviarEmail: (cfg, e) => enviarEmailResend(cfg, e), log },
        c,
        motivo,
      ),
    esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
    ferramentas: consulta
      ? (ctx) =>
          montarFerramentas(ctx, {
            consulta,
            agendador: agendarLigado
              ? new AgendadorMinhaAgenda(chaveFirebase!)
              : undefined,
            propostas: agendarLigado
              ? new RepositorioPropostasSupabase(db)
              : undefined,
            avisar: (assunto, texto) =>
              enviarResumo(
                aviso,
                { enviarEmail: (cfg, e) => enviarEmailResend(cfg, e), log },
                assunto,
                texto,
              ),
            log: logar,
            maxDias: 15, // o agendamento online abre até 15 dias à frente (Minha Agenda)
          })
      : undefined,
    log: logar,
  };

  for (const m of eventos.mensagens) {
    const { conversaId, nova } = await repo.registrarEntrada(
      m,
      iaLigadaParaNovas,
      listas.teste.has(m.waId),
    );
    if (!nova) continue; // reenvio da Meta: já tratado
    emSegundoPlano(
      processarMensagem(deps, conversaId, m).then((r) =>
        log("processado", { conversa: conversaId, resultado: r }),
      ),
    );
  }

  log("webhook", {
    mensagens: eventos.mensagens.length,
    statuses: eventos.statuses.length,
    ecos: eventos.ecos.length,
    ignorados: eventos.ignorados,
    fora_da_lista: descartados,
  });
  return new Response("ok", { status: 200 });
}
