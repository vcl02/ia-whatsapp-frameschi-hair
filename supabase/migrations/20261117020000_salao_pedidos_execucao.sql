-- Fase 2: a Bruna aprova o pedido no painel e a função salao-executar-pedido faz no
-- Minha Agenda. Só a função (service role) escreve estas colunas; a equipe só lê.
alter table public.salao_pedidos
  add column agendamento_sistema_id bigint,
  add column executado_em timestamptz,
  add column resultado text;
