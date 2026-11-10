// Desativada: o envio de mensagens pelo computador foi retirado. Respostas humanas
// são feitas pelo app do WhatsApp (o bot da conversa pausa sozinho pelo eco).
// A função fica só para responder 410, no lugar de aceitar envios.

export function tratar(_req: Request): Response {
  return new Response(
    JSON.stringify({
      erro: 'envio pelo painel desativado: responda pelo app do WhatsApp',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  );
}
