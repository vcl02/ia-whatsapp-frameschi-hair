# Pendências, fatos e suposições

## Verificado (2026-11-06)

- Testes Deno: 33 passando (assinatura, parser incl. eco do app, envio de texto e modelo
  com `fetch` falso, aviso por e-mail, regras do bot, prompt, verificação GET e recusa de
  assinatura inválida).
- Migration aplicada num Postgres 16 local com stubs do `auth`: equipe lê, pausa e edita
  serviços; fora da equipe vê 0 linhas e não grava; `salao_limpar_antigos` apaga conversa
  de 13 meses com as mensagens e não pode ser chamada por usuário logado.
- Tela testada no Chromium com Supabase falso: lista, conversa (HTML da cliente escapado),
  aba Serviços inserindo registro.
- Supabase (leitura): organização no plano free; projetos `hub` e `gestao-ammi`; o hub não
  tem tabelas `salao_*`; tem pg_cron; as políticas de leitura do hub só liberam o seu
  usuário ou o dono da linha.

## Não verificado

- Formato real do evento `smb_message_echoes` (coexistência).
- `EdgeRuntime.waitUntil`, limites de tempo das Edge Functions e comportamento de reenvio
  da Meta.
- Limite de 2 projetos ativos no plano free.
- Política atual da Meta para IA.
- Não consegui abrir o link de agendamento (rede deste ambiente bloqueia).

## Perguntas em aberto

1. Formas de pagamento (opcional).

## Limitações conhecidas

- Fora da janela de 24 h só modelo aprovado é entregue; a tela recusa texto livre nesse
  caso.
- Mensagens seguidas com mais de ~4 s de intervalo podem gerar duas respostas.
- A tela atualiza a cada 15 s.
