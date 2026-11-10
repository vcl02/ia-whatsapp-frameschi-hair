# ia-bruna — bot de WhatsApp do salão

Bot que atende as clientes do salão pelo WhatsApp (Cloud API da Meta): tira dúvidas com
base numa lista fixa de dados, entende o que a cliente quer, manda o link de agendamento e
passa para uma pessoa quando precisa.

Código separado do hub pessoal (`vcl02/hub`). **Temporariamente, para testes, roda dentro
do projeto Supabase do hub**, isolado por prefixo: tabelas `salao_*`, funções `salao-*`,
secrets `SALAO_*`. Antes de atender clientes reais, mudar para um projeto próprio (ver
`docs/decisoes.md`).

## Estrutura

```
supabase/
  migrations/                 esquema, RLS e visão de falhas de envio
  functions/
    salao-webhook/            webhook da Meta (verificação, assinatura, gravação, bot)
    salao-responder/          desativada: só responde 410 (envio é pelo app do WhatsApp)
    salao-sincronizar/        espelho diário do Minha Agenda (serviços, horário, regras)
    _shared/                  módulos comuns (assinatura, WhatsApp, LLM, regras do bot, banco)
  tests/                      testes Deno (sem rede, sem banco)
  config.toml                 verify_jwt por função
web/                          tela de conversas: ler e pausar/retomar o bot (estática)
                              publicada em https://vcl02.github.io/ia-whatsapp-frameschi-hair/painel/
site/                         política de privacidade (GitHub Pages, workflow em .github/workflows/pages.yml)
docs/                         decisões, diagnóstico dos modelos, pendências, deploy
```

## Como roda

1. A Meta chama `salao-webhook`. O código confere `X-Hub-Signature-256` com o App Secret e
   grava mensagens e `statuses`.
2. Para cada mensagem nova (dedupe por `wamid`), em segundo plano: espera alguns segundos
   para juntar mensagens seguidas; se o bot da conversa estiver pausado, não faz nada; se
   for áudio/imagem, pedido de atendente ou faltar dado do salão, passa para humano sem
   chamar a LLM; senão chama o Claude com os serviços ativos de `salao_servicos`, e ele
   devolve JSON com a resposta e se precisa de humano. A primeira resposta de cada
   conversa começa com a apresentação de assistente virtual.
3. Passar para humano = pausa o bot daquela conversa, marca "precisa de você" na tela e
   manda aviso por e-mail (Resend) para `SALAO_AVISO_EMAIL_PARA`. Só volta quando alguém
   clica em "Retomar bot".
4. Se alguém responder pelo app do celular (coexistência), o bot daquela conversa pausa
   sozinho (evento `smb_message_echoes`; formato não conferido).
5. A tela usa login do Supabase Auth; só quem está em `salao_equipe` vê algo (RLS). A tela
   só lê as conversas e liga/desliga o bot de cada uma (Pausar/Retomar). Não envia
   mensagem: respostas humanas são pelo app do WhatsApp. A função `salao-responder` ficou
   só como stub (410).
6. Conversas paradas há 12 meses são apagadas todo dia (pg_cron).

## Desenvolvimento

Requer Deno 2.

```
deno task test     # testes
deno task check    # checagem de tipos das funções
```

Dados fixos do salão (nome, endereço, tom, textos) ficam em
`supabase/functions/_shared/salao.ts`. Serviços, preços, horário e regras de agendamento
são espelhados do Minha Agenda uma vez por dia (`salao-sincronizar`) nas tabelas
`salao_servicos` e `salao_info`. Sem serviço ativo, o bot não usa a LLM e passa tudo para
humano.

Tela: publicada pelo workflow do Pages em `/painel/` (usa `web/config.publico.js`, com a
chave publishable; quem protege os dados é o RLS). A página tem CSP (só conecta ao
Supabase do projeto), SRI na biblioteca do CDN e `noindex`. `SALAO_PAINEL_ORIGEM` deve ser
`https://vcl02.github.io`. Teste local: copie `web/config.publico.js` para
`web/config.js`, rode `python3 -m http.server 8000` em `web/` e use
`SALAO_PAINEL_ORIGEM=http://localhost:8000`. Ao trocar de projeto Supabase, atualize
`config.publico.js` e o `connect-src` da CSP.

## Segredos

Nenhum segredo no repositório. Os nomes estão em `.env.example`; os valores vão só para os
secrets do Supabase. `web/config.js` (URL e chave anon do Supabase) fica fora do git.

## Deploy

Ver `docs/deploy.md`. Toda mudança remota (deploy, migration, secrets, configuração na
Meta) só depois de confirmação explícita.
