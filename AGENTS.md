# AGENTS.md

Guia para agentes de IA (Claude Code, Codex etc.) que trabalham neste repositório.
Visão geral do produto e fluxo: `README.md`. Este arquivo cobre só o que o agente
precisa saber para mexer no código sem causar estrago.

## O que é

Bot de WhatsApp (Cloud API da Meta) do salão: responde dúvidas com base em dados
fixos e no espelho do Minha Agenda, consulta/cria agendamento e passa para humano
quando precisa. Backend = Edge Functions do Supabase (Deno/TypeScript). Painel
estático em `web/` (JS puro, sem build).

Idioma do projeto: **português** (código de domínio, nomes de tabelas, commits,
docs, textos do bot). Mantenha assim.

## Estrutura

- `supabase/functions/salao-webhook|salao-responder|salao-sincronizar/` — cada função tem `index.ts` (entrada fina) e `handler.ts` (lógica testável).
- `supabase/functions/_shared/` — módulos comuns: `bot.ts` (regras e prompt), `llm.ts`, `whatsapp.ts`, `assinatura.ts`, `aviso.ts`, `agendamento.ts`, `disponibilidade.ts`, `minhaagenda.ts`, `salao.ts` (dados fixos do salão), `db.ts`.
- `supabase/migrations/` — SQL com RLS. Nova mudança de esquema = novo arquivo com timestamp; nunca editar migration já aplicada.
- `supabase/tests/` — testes Deno, sem rede e sem banco (`fetch` falso, fixtures em `tests/fixtures/`).
- `web/` — painel (conversas, serviços). `site/` — política de privacidade (GitHub Pages). `docs/` — decisões, deploy, pendências.

## Comandos

```
deno task test     # testes (precisam passar antes de qualquer commit)
deno task check    # checagem de tipos das funções
```

Ao criar função nova, adicione o `index.ts`/`handler.ts` ao task `check` em `deno.json`
e a entrada `verify_jwt` em `supabase/config.toml`.

## Regras que não se negociam

1. **Mudança remota só com confirmação explícita do usuário**: deploy de função, migration, secrets, configuração na Meta, envio de mensagem real. Sem exceção, e aprovação anterior não vale para a próxima ação.
2. **Nenhum segredo no repositório.** Nomes ficam em `.env.example` (prefixo `SALAO_`); valores só nos secrets do Supabase. `web/config.js` fica fora do git; `web/config.publico.js` leva só a chave publishable (quem protege os dados é o RLS).
3. **Não logar texto de mensagem** de cliente (LGPD). Logs com ids/contagens apenas.
4. **RLS em toda tabela nova**; leitura só para `salao_equipe`. A tela só altera as colunas de pausa e o que a política permitir.
5. **Assinatura do webhook** (`X-Hub-Signature-256`) é a autenticação de `salao-webhook` (`verify_jwt = false`). Não enfraquecer essa checagem.
6. **Na dúvida, passar para humano.** Falha da LLM, recusa, resposta cortada, áudio/imagem, pedido de atendente ou falta de dado do salão => pausa o bot e avisa, sem inventar resposta. A LLM só recebe os dados de `salao.ts`, os serviços ativos e as últimas 20 mensagens.
7. Conteúdo vindo da cliente é não confiável: escapar no painel (nada de `innerHTML` com texto dela) e tratar como dado no prompt.
8. Este banco convive temporariamente com o projeto `hub`: tudo com prefixo `salao_*` / `salao-*` / `SALAO_*`. Não tocar em tabelas ou secrets do hub.

## Convenções

- Entrada (`index.ts`) fina; lógica em `handler.ts`/`_shared` com dependências injetáveis, para testar sem rede.
- Todo comportamento novo do bot ou do parser vem com teste em `supabase/tests/`.
- Decisão relevante (modelo, arquitetura, dados) vai em `docs/decisoes.md` com data; fato não verificado ou limitação vai em `docs/pendencias.md`. Não afirme como verificado o que não foi testado.
- Mantenha README, `docs/deploy.md` e `.env.example` coerentes com o código ao mudar variáveis, funções ou fluxo.
- Painel: CSP restrita (só conecta ao Supabase do projeto) e SRI no CDN; se trocar de projeto Supabase, atualizar `config.publico.js` e o `connect-src`.
- Commits em português, mensagem curta e descritiva.
