-- Quem a IA atende, editado no painel (antes era o secret SALAO_SO_RESPONDER_PARA).
--  - lista 'teste': se tiver algum número, a IA só atende quem está nela (vale mesmo
--    para quem também está em 'familiar');
--  - lista vazia: a IA atende todos, menos os números da lista 'familiar'.
-- Número é guardado só com dígitos e código do país (ex.: 5511992090474).
create table public.salao_numeros (
  wa_id text not null check (wa_id ~ '^[0-9]{10,15}$'),
  lista text not null check (lista in ('teste', 'familiar')),
  nome text check (nome is null or char_length(nome) <= 60),
  criado_em timestamptz not null default now(),
  primary key (wa_id, lista)
);

alter table public.salao_numeros enable row level security;
create policy salao_numeros_le on public.salao_numeros
  for select to authenticated using (public.salao_eh_equipe());
create policy salao_numeros_inclui on public.salao_numeros
  for insert to authenticated with check (public.salao_eh_equipe());
create policy salao_numeros_remove on public.salao_numeros
  for delete to authenticated using (public.salao_eh_equipe());
revoke all on public.salao_numeros from anon, authenticated;
grant select, insert, delete on public.salao_numeros to authenticated;

-- Mantém o comportamento atual: só a Isa na lista de teste.
insert into public.salao_numeros (wa_id, lista, nome) values ('5511992090474', 'teste', 'Isa')
on conflict do nothing;
