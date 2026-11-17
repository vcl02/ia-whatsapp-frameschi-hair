-- 1) Histórico de quem pausou ou retomou a IA de cada conversa.
--    "por" = e-mail de quem mexeu no painel, ou "sistema" (a própria IA passando para
--    a Bruna, resposta pelo app do WhatsApp, conversa nova com a IA desligada).
--    Só ids, e-mail da equipe e motivo: nunca o texto das conversas.
create table public.salao_pausas (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.salao_conversas (id) on delete cascade,
  pausado boolean not null,
  por text not null,
  motivo text,
  criado_em timestamptz not null default now()
);
create index salao_pausas_conversa_idx on public.salao_pausas (conversa_id, criado_em desc);

alter table public.salao_pausas enable row level security;
create policy salao_pausas_le on public.salao_pausas
  for select to authenticated using (public.salao_eh_equipe());
revoke all on public.salao_pausas from anon, authenticated;
grant select on public.salao_pausas to authenticated;

create or replace function public.salao_registrar_pausa() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  quem text := coalesce(nullif(auth.jwt() ->> 'email', ''), 'sistema');
begin
  if tg_op = 'INSERT' then
    if new.bot_pausado then
      insert into public.salao_pausas (conversa_id, pausado, por, motivo)
      values (new.id, true, quem, 'conversa nova com a IA desligada');
    end if;
  elsif new.bot_pausado is distinct from old.bot_pausado then
    insert into public.salao_pausas (conversa_id, pausado, por, motivo)
    values (
      new.id,
      new.bot_pausado,
      quem,
      case
        when not new.bot_pausado then null
        when new.precisa_humano and new.motivo_humano is not null then new.motivo_humano
        when quem = 'sistema' then 'resposta pelo app do WhatsApp ou regra do sistema'
      end
    );
  end if;
  return new;
end;
$$;
revoke all on function public.salao_registrar_pausa() from public, anon, authenticated;

create trigger salao_conversas_registrar_pausa
  after insert or update of bot_pausado on public.salao_conversas
  for each row execute function public.salao_registrar_pausa();

-- 2) Agendamento que a equipe cancelou ou remarcou direto no Minha Agenda
--    (o horário voltou a aparecer livre).
alter table public.salao_agendamentos drop constraint salao_agendamentos_status_check;
alter table public.salao_agendamentos add constraint salao_agendamentos_status_check
  check (status in (
    'proposto', 'agendando', 'agendado', 'falhou', 'expirado', 'substituido',
    'cancelado_no_sistema'
  ));
