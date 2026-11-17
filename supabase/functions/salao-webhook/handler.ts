// Webhook da WhatsApp Cloud API (bot do salão).
// GET  -> verificação (hub.challenge)
// POST -> valida X-Hub-Signature-256, grava mensagens, ecos e statuses, responde 200 e processa a resposta do bot em segundo plano.

import { assinaturaValida } from '../_shared/assinatura.ts';
import {
  type ConfigWhatsApp,
  enviarModelo,
  enviarTexto,
  filtrarPorListas,
  lerEventos,
} from '../_shared/whatsapp.ts';
import {
  ArmazemSessaoSupabase,
  ArmazemTokenPainelSupabase,
  CacheAgendaSupabase,
  clienteServico,
  exigirEnv,
  RepositorioPedidosSupabase,
  RepositorioPropostasSupabase,
  RepositorioSupabase,
} from '../_shared/db.ts';
import { ConsultaMinhaAgenda, hojeSaoPaulo } from '../_shared/disponibilidade.ts';
import {
  AgendadorMinhaAgenda,
  conferirAgendamentoNoSistema,
  contextoDaAgendaReal,
  contextoDoAgendamento,
  garantirPedido,
  montarFerramentas,
  receberComprovante,
} from '../_shared/agendamento.ts';
import { type DepsBot, processarMensagem } from '../_shared/bot.ts';
import {
  avisarEquipe,
  avisarEquipeWhatsapp,
  enviarEmailResend,
  enviarResumo,
  lerConfigsAviso,
  lerNumerosAvisoWhatsapp,
} from '../_shared/aviso.ts';
import { criarAtendente } from '../_shared/atendente.ts';
import {
  lerCredenciaisPainel,
  PainelMinhaAgenda,
} from '../_shared/painel_minhaagenda.ts';
import { SALAO } from '../_shared/salao.ts';
import { EVENTO_DE_ERRO, registrarEvento } from '../_shared/eventos.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function log(evento: string, dados: Record<string, unknown> = {}) {
  // Sem texto de mensagem no log (LGPD).
  console.log(JSON.stringify({ evento, ...dados }));
}

function emSegundoPlano(p: Promise<unknown>) {
  const seguro = p.catch((e) => log('erro_segundo_plano', { erro: String(e) }));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(seguro);
  return seguro;
}

async function tratarInterno(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') ===
        exigirEnv('SALAO_WHATSAPP_VERIFY_TOKEN');
    return ok
      ? new Response(url.searchParams.get('hub.challenge') ?? '', {
        status: 200,
      })
      : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const corpo = new Uint8Array(await req.arrayBuffer());
  const valida = await assinaturaValida(
    corpo,
    req.headers.get('x-hub-signature-256'),
    exigirEnv('SALAO_META_APP_SECRET'),
  );
  if (!valida) {
    log('assinatura_invalida');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(corpo));
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const wa: ConfigWhatsApp = {
    token: exigirEnv('SALAO_WHATSAPP_TOKEN'),
    phoneNumberId: exigirEnv('SALAO_WHATSAPP_PHONE_NUMBER_ID'),
    graphApiVersion: exigirEnv('SALAO_GRAPH_API_VERSION'),
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
          .from('salao_eventos')
          .insert({ tipo: evento, detalhe: JSON.stringify(dados).slice(0, 500) }),
      ).then(({ error }) => {
        if (error) log('falha_gravar_evento', { erro: String(error.message) });
      }),
    );
  };
  // Consulta e agendamento no Minha Agenda: só ligam com a chave do Firebase configurada.
  // O agendamento pode ser desligado à parte com SALAO_AGENDAR=nao.
  const chaveFirebase = Deno.env.get('SALAO_MA_FIREBASE_KEY');
  const consulta = chaveFirebase
    ? new ConsultaMinhaAgenda(
      chaveFirebase,
      new ArmazemSessaoSupabase(db),
      fetch,
      () => Date.now(),
      // O Minha Agenda respondeu 200, mas num formato novo: sem isto o bot diria
      // "sem horários" sem ninguém saber.
      (onde) => logar('erro_formato_minhaagenda', { onde }),
    )
    : null;
  const agendarLigado = !!chaveFirebase && Deno.env.get('SALAO_AGENDAR') !== 'nao';
  const aviso = lerConfigsAviso((n) => Deno.env.get(n));
  const numerosAviso = lerNumerosAvisoWhatsapp((n) => Deno.env.get(n));
  const avisarResumo = (assunto: string, texto: string) =>
    enviarResumo(
      aviso,
      { enviarEmail: (cfg, e) => enviarEmailResend(cfg, e), log: logar },
      assunto,
      texto,
    );
  // Painel do Minha Agenda (agenda real da Bruna): só com as 3 credenciais nos secrets.
  const credPainel = lerCredenciaisPainel((n) => Deno.env.get(n));
  const painel = credPainel
    ? new PainelMinhaAgenda(
      credPainel,
      new ArmazemTokenPainelSupabase(db),
      new CacheAgendaSupabase(db),
    )
    : null;
  const agendador = agendarLigado ? new AgendadorMinhaAgenda(chaveFirebase!) : undefined;
  const propostas = agendarLigado ? new RepositorioPropostasSupabase(db) : undefined;
  const pedidos = new RepositorioPedidosSupabase(db);
  // Chave Pix do sinal (secrets do Supabase). Sem elas a IA não propõe agendamento.
  const chavePix = Deno.env.get('SALAO_PIX_CHAVE');
  const titularPix = Deno.env.get('SALAO_PIX_TITULAR');
  const pix = chavePix && titularPix
    ? { chave: chavePix, titular: titularPix }
    : undefined;

  for (const s of eventos.statuses) {
    await repo.registrarStatus(s);
    if (s.status === 'failed') {
      logar('status_falha', { wamid: s.wamid, erros: s.erros });
    }
  }
  for (const e of eventos.ecos) {
    await repo.registrarEco(e, listas.teste.has(e.para));
  }

  const deps: DepsBot = {
    repo,
    atendente: criarAtendente((n) => Deno.env.get(n)),
    salao: SALAO,
    enviar: (para, texto) => enviarTexto(wa, para, texto),
    avisar: async (c, motivo) => {
      // E-mail (uma conta por pessoa) e WhatsApp: um canal falhar não derruba o outro.
      await avisarEquipe(
        aviso,
        { enviarEmail: (cfg, e) => enviarEmailResend(cfg, e), log: logar },
        c,
        motivo,
      );
      await avisarEquipeWhatsapp(
        numerosAviso,
        (para, modelo, idioma, params) => enviarModelo(wa, para, modelo, idioma, params),
        logar,
        c,
        motivo,
      );
    },
    esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
    ferramentas: consulta
      ? (ctx) =>
        montarFerramentas(ctx, {
          consulta,
          agendador,
          propostas,
          pedidos,
          painel: painel ?? undefined,
          pix,
          avisar: avisarResumo,
          log: logar,
          maxDias: 15, // o agendamento online abre até 15 dias à frente (Minha Agenda)
        })
      : undefined,
    receberComprovante: consulta && agendador && propostas
      ? (c, m) =>
        receberComprovante(
          { conversaId: c.id, waId: c.waId },
          {
            consulta,
            agendador,
            propostas,
            avisar: avisarResumo,
            log: logar,
            semLimiteDiario: listas.teste.has(c.waId),
          },
          m.tipo,
        )
      : undefined,
    contextoAgendamento: propostas
      ? async (conversaId, waId) => {
        // Agenda real (painel com o login da Bruna). Se o painel não estiver configurado
        // ou falhar, cai na conferência pelos horários livres da página pública.
        let real: string | null = null;
        if (painel) {
          try {
            real = await contextoDaAgendaReal(
              painel,
              propostas,
              conversaId,
              waId,
              new Date(),
              logar,
            );
          } catch (e) {
            logar('erro_painel_minhaagenda', { erro: String(e) });
          }
        }
        const noSistema = !real && consulta
          ? await conferirAgendamentoNoSistema(
            propostas,
            consulta,
            conversaId,
            new Date(),
            logar,
          )
          : null;
        const contexto = await contextoDoAgendamento(
          propostas,
          conversaId,
          new Date(),
          (ms) => new Promise((r) => setTimeout(r, ms)),
        );
        return [real ?? noSistema, contexto].filter(Boolean).join('\n') || null;
      }
      : undefined,
    registrarPedidoCancelamento: (conversaId, motivo) =>
      garantirPedido(
        pedidos,
        propostas,
        conversaId,
        motivo,
        hojeSaoPaulo(new Date()),
      ),
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
        log('processado', { conversa: conversaId, resultado: r })
      ),
    );
  }

  log('webhook', {
    mensagens: eventos.mensagens.length,
    statuses: eventos.statuses.length,
    ecos: eventos.ecos.length,
    ignorados: eventos.ignorados,
    fora_da_lista: descartados,
  });
  return new Response('ok', { status: 200 });
}

/** Quebra geral (falta de secret, banco fora do ar etc.): registra no painel e deixa o erro subir (a Meta reenvia). */
export async function tratar(req: Request): Promise<Response> {
  try {
    return await tratarInterno(req);
  } catch (e) {
    log('erro_funcao_webhook', { erro: String(e) });
    try {
      await registrarEvento(clienteServico(), 'erro_funcao_webhook', {
        erro: String(e),
      });
    } catch { /* sem banco ou sem env: o log acima já registrou */ }
    throw e;
  }
}
