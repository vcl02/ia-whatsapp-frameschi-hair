import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.13';
import {
  avisarEquipe,
  avisarEquipeWhatsapp,
  type ConfigAviso,
  type Email,
  enviarEmailResend,
  enviarResumo,
  lerConfigAviso,
  lerConfigsAviso,
  lerNumerosAvisoWhatsapp,
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

Deno.test('config: a conta da Bruna só entra se estiver completa', () => {
  const base: Record<string, string> = {
    SALAO_AVISO_EMAIL_PARA: 'a@x.com',
    SALAO_AVISO_EMAIL_DE: 'bot@x.com',
    SALAO_RESEND_API_KEY: 'k1',
  };
  assertEquals(lerConfigsAviso((n) => base[n]).length, 1);
  const env: Record<string, string> = {
    ...base,
    SALAO_AVISO_EMAIL_PARA_BRUNA: 'bruna@x.com',
    SALAO_AVISO_EMAIL_DE_BRUNA: 'onboarding@resend.dev',
    SALAO_RESEND_API_KEY_BRUNA: 'k2',
  };
  const c = lerConfigsAviso((n) => env[n]);
  assertEquals(c.map((x) => [x.para, x.apiKey]), [[['a@x.com'], 'k1'], [
    ['bruna@x.com'],
    'k2',
  ]]);
});

Deno.test('cada conta recebe com a sua chave; uma falhar não impede a outra', async () => {
  const usadas: string[] = [];
  const logs: string[] = [];
  const d = {
    enviarEmail: (c: ConfigAviso) => {
      usadas.push(c.apiKey!);
      return c.apiKey === 'k1'
        ? Promise.resolve({ ok: false, status: 403 })
        : Promise.resolve({ ok: true, status: 200 });
    },
    log: (e: string) => void logs.push(e),
  };
  const cfgs: ConfigAviso[] = [
    { para: ['a@x.com'], de: 'bot@x.com', apiKey: 'k1' },
    { para: ['b@x.com'], de: 'onboarding@resend.dev', apiKey: 'k2' },
  ];
  await avisarEquipe(cfgs, d, conversa, 'x');
  assertEquals(usadas, ['k1', 'k2']);
  assertEquals(logs.filter((l) => l === 'erro_aviso_email').length, 1);
  await enviarResumo(cfgs, d, 'assunto', 'texto');
  assertEquals(usadas.length, 4);
});

Deno.test('números do aviso por WhatsApp: normaliza e ignora lixo', () => {
  const env: Record<string, string> = {
    SALAO_AVISO_WHATSAPP_PARA: '(11) 98897-3181, 5521999990000, 123',
  };
  assertEquals(lerNumerosAvisoWhatsapp((n) => env[n]), [
    '5511988973181',
    '5521999990000',
  ]);
  assertEquals(lerNumerosAvisoWhatsapp(() => undefined), []);
});

Deno.test('aviso por WhatsApp: modelo aviso_atendimento_equipe com cliente e motivo, sem quebra de linha', async () => {
  const chamadas: Array<[string, string, string, string[]]> = [];
  const logs: string[] = [];
  const falha = { ok: false, wamid: null, httpStatus: 400, erro: 'x' };
  const ok = { ok: true, wamid: 'w', httpStatus: 200, erro: null };
  await avisarEquipeWhatsapp(
    ['5511988973181', '5521999990000'],
    (para, modelo, idioma, params) => {
      chamadas.push([para, modelo, idioma, params]);
      return Promise.resolve(para === '5511988973181' ? falha : ok);
    },
    (e) => void logs.push(e),
    conversa,
    'pediu a Bruna\n\ne    mais   coisa',
  );
  assertEquals(chamadas.length, 2); // o primeiro falhar não impede o segundo
  assertEquals(chamadas[0].slice(1), [
    'aviso_atendimento_equipe',
    'pt_BR',
    ['Ana (+5511999990000)', 'pediu a Bruna e mais coisa'],
  ]);
  assertEquals(logs.filter((l) => l === 'erro_aviso_whatsapp').length, 1);
  // sem números: não faz nada
  await avisarEquipeWhatsapp(
    [],
    () => Promise.reject(new Error('não devia')),
    () => {},
    conversa,
    'x',
  );
});
