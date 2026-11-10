import { assertEquals } from 'jsr:@std/assert@1.0.13';
import { tratar } from '../functions/salao-webhook/handler.ts';

Deno.env.set('SALAO_WHATSAPP_VERIFY_TOKEN', 'tok');
Deno.env.set('SALAO_META_APP_SECRET', 'segredo');

Deno.test('GET devolve o hub.challenge com o token certo', async () => {
  const r = await tratar(
    new Request('http://x/?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123'),
  );
  assertEquals(r.status, 200);
  assertEquals(await r.text(), '123');
});

Deno.test('GET com token errado é recusado', async () => {
  const r = await tratar(
    new Request('http://x/?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123'),
  );
  assertEquals(r.status, 403);
});

Deno.test('POST sem assinatura válida é recusado antes de tocar no banco', async () => {
  const r = await tratar(
    new Request('http://x/', {
      method: 'POST',
      body: '{}',
      headers: { 'x-hub-signature-256': 'sha256=00' },
    }),
  );
  assertEquals(r.status, 401);
});
