-- Painel do Minha Agenda (login da Bruna): token reaproveitado e cache da agenda do dia.
-- Só as Edge Functions (service role) acessam: RLS ligado e nenhuma política.
-- O cache tem nome, telefone e serviço das clientes da agenda: some sozinho quando o dia passa.
create table public.salao_token_painel (
  id smallint primary key default 1 check (id = 1),  -- uma linha só
  token text not null,
  expira_em timestamptz not null,
  atualizado_em timestamptz not null default now()
);
alter table public.salao_token_painel enable row level security;
revoke all on public.salao_token_painel from anon, authenticated;

create table public.salao_agenda_cache (
  data date primary key,
  itens jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.salao_agenda_cache enable row level security;
revoke all on public.salao_agenda_cache from anon, authenticated;

create or replace function public.salao_limpar_antigos() returns void
language sql
security definer
set search_path = public
as $$
  delete from public.salao_conversas where atualizado_em < now() - interval '12 months';
  delete from public.salao_status where recebido_em < now() - interval '12 months';
  delete from public.salao_eventos where criado_em < now() - interval '90 days';
  delete from public.salao_agenda_cache where data < current_date;
$$;
revoke all on function public.salao_limpar_antigos() from public, anon, authenticated;
