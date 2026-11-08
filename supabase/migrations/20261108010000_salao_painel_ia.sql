-- Painel inicial da IA: interruptor global liga/desliga e resumo do dia.
-- A equipe logada liga/desliga a IA e vê números e agendamentos, nunca o texto das conversas.

-- ---------- interruptor global ----------
create table public.salao_controle (
  id int primary key default 1 check (id = 1),   -- linha única
  ia_ativa boolean not null default true,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid
);
insert into public.salao_controle (id) values (1) on conflict do nothing;

alter table public.salao_controle enable row level security;
create policy salao_controle_le on public.salao_controle
  for select to authenticated using (public.salao_eh_equipe());
create policy salao_controle_liga on public.salao_controle
  for update to authenticated using (public.salao_eh_equipe()) with check (public.salao_eh_equipe());
revoke all on public.salao_controle from anon, authenticated;
grant select on public.salao_controle to authenticated;
grant update (ia_ativa) on public.salao_controle to authenticated;

-- Carimba quem e quando mudou (o painel não escolhe esses campos).
create function public.salao_controle_carimbo() returns trigger
language plpgsql set search_path = public as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := (select auth.uid());
  return new;
end;
$$;
revoke all on function public.salao_controle_carimbo() from public, anon, authenticated;
create trigger salao_controle_carimbo before update on public.salao_controle
  for each row execute function public.salao_controle_carimbo();

-- ---------- resumo do dia (só números) ----------
create function public.salao_painel_resumo() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ini timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
begin
  if not public.salao_eh_equipe() then
    raise exception 'sem acesso' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'conversas_hoje',    (select count(*) from public.salao_conversas where ultimo_inbound_em >= ini),
    'respostas_hoje',    (select count(*) from public.salao_mensagens where autor = 'bot' and criado_em >= ini),
    'agendamentos_hoje', (select count(*) from public.salao_agendamentos where status = 'agendado' and atualizado_em >= ini),
    'precisam_atencao',  (select count(*) from public.salao_conversas where precisa_humano),
    'falhas_24h',        (select count(*) from public.salao_falhas_de_envio where recebido_em >= now() - interval '24 hours')
  );
end;
$$;
revoke all on function public.salao_painel_resumo() from public, anon;
grant execute on function public.salao_painel_resumo() to authenticated;
