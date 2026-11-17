// Executa no Minha Agenda um pedido de cancelamento/remarcação que a Bruna aprovou no
// painel do salão (botão "Fazer no Minha Agenda"). Exige JWT (verify_jwt = true) e, além
// disso, que quem chama seja da equipe (salao_eh_equipe). A IA não chama esta função.

import { createClient } from '../_shared/deps.ts';
import {
  ArmazemTokenPainelSupabase,
  CacheAgendaSupabase,
  clienteServico,
  exigirEnv,
  RepositorioExecucaoSupabase,
  RepositorioSupabase,
} from '../_shared/db.ts';
import { executarPedido } from '../_shared/execucao.ts';
import {
  lerCredenciaisPainel,
  PainelMinhaAgenda,
} from '../_shared/painel_minhaagenda.ts';
import { type ConfigWhatsApp, enviarTexto } from '../_shared/whatsapp.ts';
import { registrarEvento } from '../_shared/eventos.ts';

function log(evento: string, dados: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ evento, ...dados }));
}

/** Origens do painel que podem chamar (SALAO_PAINEL_ORIGEM, separadas por vírgula). */
function cors(req: Request): Record<string, string> {
  const permitidas = (Deno.env.get('SALAO_PAINEL_ORIGEM') || 'https://vcl02.github.io')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origem = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': permitidas.includes(origem) ? origem : permitidas[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export async function tratar(req: Request): Promise<Response> {
  const h = cors(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  const json = (status: number, corpo: unknown) =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { ...h, 'Content-Type': 'application/json' },
    });
  if (req.method !== 'POST') {
    return json(405, { ok: false, mensagem: 'método não permitido' });
  }

  // Quem chama tem que ser da equipe (o JWT já foi validado pelo Supabase).
  const auth = req.headers.get('authorization') ?? '';
  const comoUsuario = createClient(
    exigirEnv('SUPABASE_URL'),
    exigirEnv('SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } },
  );
  const { data: ehEquipe, error: erroEquipe } = await comoUsuario.rpc('salao_eh_equipe');
  if (erroEquipe || ehEquipe !== true) {
    return json(403, { ok: false, mensagem: 'só a equipe do salão pode fazer isso' });
  }

  const corpo = await req.json().catch(() => ({})) as { pedido_id?: unknown };
  const pedidoId = typeof corpo.pedido_id === 'string' ? corpo.pedido_id : '';
  if (!/^[0-9a-f-]{36}$/.test(pedidoId)) {
    return json(400, { ok: false, mensagem: 'pedido inválido' });
  }

  const cred = lerCredenciaisPainel((n) => Deno.env.get(n));
  if (!cred) {
    return json(503, { ok: false, mensagem: 'acesso ao Minha Agenda não configurado' });
  }
  const db = clienteServico();
  const wa: ConfigWhatsApp = {
    token: exigirEnv('SALAO_WHATSAPP_TOKEN'),
    phoneNumberId: exigirEnv('SALAO_WHATSAPP_PHONE_NUMBER_ID'),
    graphApiVersion: exigirEnv('SALAO_GRAPH_API_VERSION'),
  };
  const repoMensagens = new RepositorioSupabase(db);
  try {
    const r = await executarPedido(
      {
        repo: new RepositorioExecucaoSupabase(db),
        painel: new PainelMinhaAgenda(
          cred,
          new ArmazemTokenPainelSupabase(db),
          new CacheAgendaSupabase(db),
        ),
        enviar: (para, texto) => enviarTexto(wa, para, texto),
        registrarSaida: (conversaId, texto, envio) =>
          repoMensagens.registrarSaida(conversaId, 'bot', texto, envio),
        log: (evento, dados = {}) => {
          log(evento, dados);
          if (evento.startsWith('erro_')) {
            registrarEvento(db, evento, dados).catch(() => {});
          }
        },
      },
      pedidoId,
    );
    return json(r.ok ? 200 : 409, r);
  } catch (e) {
    log('erro_funcao_executar_pedido', { erro: String(e) });
    await registrarEvento(db, 'erro_funcao_executar_pedido', { erro: String(e) }).catch(
      () => {},
    );
    return json(500, { ok: false, mensagem: 'erro inesperado: nada foi confirmado' });
  }
}
