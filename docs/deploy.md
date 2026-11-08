# Deploy de teste (cada passo exige confirmação antes de ser executado)

## Estado em 2026-11-06
- Feito: migration `salao_inicial` (rodada pelo Victor no SQL Editor),
  Victor em `salao_equipe`, funções `salao-webhook` (v1, sem JWT) e
  `salao-responder` (v1, com JWT) publicadas no hub.
- 2026-11-06: secrets `SALAO_*` cadastrados, webhook assinado na Meta, primeira
  conversa de teste entregue e lida. `salao-webhook` republicada com a lista
  `SALAO_SO_RESPONDER_PARA` (só a Isa responde na fase de testes).
- 2026-11-07: espelho do Minha Agenda no ar (`salao-sincronizar`, pg_cron
  diário 09:07 UTC). Primeira sincronização: 64 serviços, horário e regras.
  `salao-webhook` lê horário/regras do banco. Revoke da função de gatilho aplicado.
- Obs.: as ferramentas de alteração do Supabase usadas pelo assistente
  travam numa confirmação que não chega ao usuário; DDL vai pelo SQL Editor.

Alvo durante os testes: projeto Supabase **hub** (`yzmyncxoskvqzdczaill`),
isolado por prefixo. Número: o seu número já registrado na API.

| # | Ação | Alvo | Efeito |
|---|------|------|--------|
| 1 | Aplicar `supabase/migrations/20261106000000_salao_inicial.sql` | banco do hub | cria tabelas/visão/funções `salao_*` com RLS e agenda a limpeza diária no pg_cron (`salao-limpar-antigos`). Não toca nas tabelas do hub |
| 2 | Inserir o seu usuário em `salao_equipe` | tabela `salao_equipe` | libera a tela para você |
| 3 | Cadastrar serviços e preços (pela tela, depois do passo 6) | tabela `salao_servicos` | o bot passa a responder com a LLM |
| 4 | Secrets `SALAO_*` (lista em `.env.example`) | Edge Functions do hub (vale para o projeto todo) | guarda token da Meta, app secret, chave da Anthropic, e-mail de aviso |
| 5 | Deploy de `salao-webhook` (e `salao-responder`, que só responde 410) | Edge Functions do hub | publica as URLs; as funções do hub não mudam |
| 6 | Webhook no app da Meta: URL de `salao-webhook` + verify token; assinar `messages` (e `smb_message_echoes` quando for o número da Bruna) | app na Meta | a Meta passa a mandar mensagens e statuses |
| 7 | Conta no Resend, domínio/remetente verificado, chave em `SALAO_RESEND_API_KEY` | Resend | ativa o aviso por e-mail |

Teste: mensagens a partir do celular da sua esposa.

Rollback: pausar o bot de todas as conversas
(`update salao_conversas set bot_pausado = true;`), remover a URL do
webhook no app da Meta, ou apagar as funções `salao-*`. Para remover tudo
do hub: `cron.unschedule('salao-limpar-antigos')` e `drop` das tabelas,
visão e funções `salao_*`.

## Antes de clientes reais
1. Projeto Supabase próprio do salão; repetir 1–6 lá.
2. Conferir endereço (grafia e cidade) em `salao.ts`.
3. Conferir a política atual da Meta para IA.
4. Confirmar com a Bruna se ela usa os lembretes por WhatsApp do Minha Agenda.
5. Migrar o número da Bruna (coexistência) e assinar `smb_message_echoes`.
