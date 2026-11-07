// Validação do cabeçalho X-Hub-Signature-256 da Meta:
// "sha256=" + HMAC-SHA256(corpo bruto, app secret) em hexadecimal.

const encoder = new TextEncoder();

async function hmacHex(
  segredo: string,
  corpo: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const chave = await crypto.subtle.importKey(
    "raw",
    encoder.encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = new Uint8Array(
    await crypto.subtle.sign("HMAC", chave, corpo),
  );
  return Array.from(assinatura, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

function iguaisTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function assinaturaValida(
  corpo: Uint8Array<ArrayBuffer>,
  cabecalho: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!cabecalho || !appSecret) return false;
  const [algoritmo, recebida] = cabecalho.split("=", 2);
  if (algoritmo !== "sha256" || !recebida) return false;
  const esperada = await hmacHex(appSecret, corpo);
  return iguaisTempoConstante(esperada, recebida.toLowerCase());
}

export { hmacHex };
