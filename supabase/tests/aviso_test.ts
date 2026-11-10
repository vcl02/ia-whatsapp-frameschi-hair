import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.13';
import {
  avisarEquipe,
  type ConfigAviso,
  type Email,
  enviarEmailResend,
  lerConfigAviso,
} from '../functions/_shared/aviso.ts';

const conversa = { id: 'c1', waId: '5511999990000', nomePerfil: 'Ana', botPausado: true };
const cfg: ConfigAviso = { para: ['a@x.com'], de: 'bot@x.com', apiKey: 'k' };

function deps() {
  const enviados: Email[] = [];
  const logs: Record<string, unknown>[] = [];
  return {
    enviados,
    logs,
    d: {
      enviarEmail: (_c: ConfigAviso, e: Email) => {
        enviados.push(e);
        return Promise.resolve({ ok: true, status: 200 });
      },
      log: (_e: string, dados?: Record<string, unknown>) => {
        logs.push(dados ?? {});
      },
    },
  };
}

Deno.test('config: lista de e-mails', () => {
  const env: Record<string, string> = {
    SALAO_AVISO_EMAIL_PARA: 'a@x.com, b@y.com,lixo',
    SALAO_AVISO_EMAIL_DE: 'bot@x.com',
    SALAO_RESEND_API_KEY: 'k',
  };
  const c = lerConfigAviso((n) => env[n]);
  assertEquals(c.para, ['a@x.com', 'b@y.com']);
  assertEquals(c.de, 'bot@x.com');
});

Deno.test('manda e-mail com cliente e motivo, sem texto da conversa', async () => {
  const t = deps();
  await avisarEquipe(cfg, t.d, conversa, 'cliente pediu atendimento humano');
  assertEquals(t.enviados.length, 1);
  assertEquals(t.enviados[0].para, ['a@x.com']);
  assertStringIncludes(t.enviados[0].texto, 'Ana (+5511999990000)');
  assertStringIncludes(t.enviados[0].texto, 'cliente pediu atendimento humano');
});

Deno.test('sem configuração: não envia, só registra', async () => {
  const t = deps();
  await avisarEquipe({ para: [], de: null, apiKey: null }, t.d, conversa, 'x');
  assertEquals(t.enviados.length, 0);
  assertEquals(t.logs[0].via, 'nenhum');
});

Deno.test('Resend: monta a requisição', async () => {
  let pedido: Request | undefined;
  const fakeFetch = (async (u: string, init: RequestInit) => {
    pedido = new Request(u, init);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const r = await enviarEmailResend(cfg, {
    de: 'bot@x.com',
    para: ['a@x.com'],
    assunto: 's',
    texto: 't',
  }, fakeFetch);
  assertEquals(r.ok, true);
  assertEquals(pedido!.url, 'https://api.resend.com/emails');
  assertEquals(pedido!.headers.get('authorization'), 'Bearer k');
  const b = await pedido!.json();
  assertEquals([b.from, b.to, b.subject, b.text], ['bot@x.com', ['a@x.com'], 's', 't']);
});
