-- Cancelamento assistido: quando a cliente pede para cancelar ou remarcar, o sistema
-- marca o agendamento dela (a Bruna cancela no Minha Agenda e decide sobre o sinal).
alter table public.salao_agendamentos
  add column if not exists cancelamento_pedido_em timestamptz;
