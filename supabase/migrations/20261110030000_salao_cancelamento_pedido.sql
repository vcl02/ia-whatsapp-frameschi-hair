-- Cancelamento assistido e remarcação: o sistema marca o agendamento antigo quando a
-- cliente pede para cancelar/remarcar (a Bruna cancela no Minha Agenda), e a remarcação
-- feita pela IA liga o agendamento novo ao antigo.
alter table public.salao_agendamentos
  add column if not exists cancelamento_pedido_em timestamptz,
  add column if not exists remarcado_de uuid references public.salao_agendamentos (id) on delete set null;
