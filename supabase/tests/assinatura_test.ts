import { assertEquals } from 'jsr:@std/assert@1.0.13';
import { assinaturaValida, hmacHex } from '../functions/_shared/assinatura.ts';

const corpo = new TextEncoder().encode('{"object":"whatsapp_business_account"}');

Deno.test('aceita assinatura correta', async () => {
  const h = 'sha256=' + await hmacHex('segredo', corpo);
  assertEquals(await assinaturaValida(corpo, h, 'segredo'), true);
});

Deno.test('aceita hex em maiúsculas', async () => {
  const h = 'sha256=' + (await hmacHex('segredo', corpo)).toUpperCase();
  assertEquals(await assinaturaValida(corpo, h, 'segredo'), true);
});

Deno.test('recusa segredo errado, corpo alterado, cabeçalho ausente ou malformado', async () => {
  const h = 'sha256=' + await hmacHex('segredo', corpo);
  assertEquals(await assinaturaValida(corpo, h, 'outro'), false);
  assertEquals(
    await assinaturaValida(new TextEncoder().encode('{}'), h, 'segredo'),
    false,
  );
  assertEquals(await assinaturaValida(corpo, null, 'segredo'), false);
  assertEquals(await assinaturaValida(corpo, 'sha1=abc', 'segredo'), false);
  assertEquals(await assinaturaValida(corpo, h, ''), false);
});
