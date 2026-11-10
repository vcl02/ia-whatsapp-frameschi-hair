-- Pedidos de cancelamento e remarcação: a IA coleta os dados e a Bruna finaliza no
-- Minha Agenda, marca como feito no painel e avisa a cliente.
-- A IA (service role) insere; a equipe lê e só altera o status.
create table public.salao_pedidos (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.salao_conversas (id) on delete cascade,
  agendamento_id uuid references public.salao_agendamentos (id) on delete set null,
  tipo text not null check (tipo in ('cancelar', 'remarcar', 'indefinido')),
  horario_atual text,
  novo_data date,
  novo_hora text,
  novo_profissional text,
  motivo text not null default '',
  -- Detalhes e alertas da IA. Só a equipe vê (painel); nunca vai para a cliente.
  observacao text not null default '',
  status text not null default 'pendente' check (status in ('pendente', 'feito', 'substituido')),
  criado_em timestamptz not null default now(),
  feito_em timestamptz
);
create index salao_pedidos_status_idx on public.salao_pedidos (status, criado_em desc);
create index salao_pedidos_conversa_idx on public.salao_pedidos (conversa_id, criado_em desc);

alter table public.salao_pedidos enable row level security;
create policy salao_pedidos_le on public.salao_pedidos
  for select to authenticated using (public.salao_eh_equipe());
create policy salao_pedidos_altera on public.salao_pedidos
  for update to authenticated
  using (public.salao_eh_equipe())
  with check (public.salao_eh_equipe() and status in ('pendente', 'feito'));
revoke all on public.salao_pedidos from anon, authenticated;
grant select on public.salao_pedidos to authenticated;
grant update (status, feito_em) on public.salao_pedidos to authenticated;
