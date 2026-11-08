-- Lembrete a cada 7 minutos do comprovante do Pix (função salao-lembrete).
alter table public.salao_agendamentos
  add column if not exists lembretes smallint not null default 0;

-- Chamada a cada minuto pelo pg_cron, se pg_cron e pg_net existirem.
-- A função não exige JWT; ela só envia lembretes vencidos e no máximo 4 por proposta.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.schedule(
      'salao-lembrete',
      '* * * * *',
      $cmd$select net.http_post(
        url := 'https://yzmyncxoskvqzdczaill.supabase.co/functions/v1/salao-lembrete',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := '{}'::jsonb
      )$cmd$
    );
  end if;
end;
$$;
