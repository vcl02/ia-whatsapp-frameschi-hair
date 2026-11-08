-- Erros internos da IA (falha ao gerar resposta, ao agendar, ao consultar horários,
-- mensagem não entregue...) gravados pelas Edge Functions para aparecer no painel.
-- Só tipo e detalhe técnico do erro: nunca o texto das conversas.
create table public.salao_eventos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null,
  detalhe text,
  criado_em timestamptz not null default now()
);
create index salao_eventos_criado_idx on public.salao_eventos (criado_em desc);

alter table public.salao_eventos enable row level security;
create policy salao_eventos_le on public.salao_eventos
  for select to authenticated using (public.salao_eh_equipe());
revoke all on public.salao_eventos from anon, authenticated;
grant select on public.salao_eventos to authenticated;

-- Retenção: eventos com mais de 90 dias saem (conversas e statuses seguem 12 meses).
create or replace function public.salao_limpar_antigos() returns void
language sql
security definer
set search_path = public
as $$
  delete from public.salao_conversas where atualizado_em < now() - interval '12 months';
  delete from public.salao_status where recebido_em < now() - interval '12 months';
  delete from public.salao_eventos where criado_em < now() - interval '90 days';
$$;
revoke all on function public.salao_limpar_antigos() from public, anon, authenticated;

-- O contador de erros do painel passa a incluir esses eventos.
create or replace function public.salao_painel_resumo() returns jsonb
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
                         + (select count(*) from public.salao_eventos where criado_em >= now() - interval '24 hours')
  );
end;
$$;
revoke all on function public.salao_painel_resumo() from public, anon;
grant execute on function public.salao_painel_resumo() to authenticated;
