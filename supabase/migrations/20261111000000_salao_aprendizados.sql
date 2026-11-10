-- Aprendizados: correções e orientações da equipe que entram no contexto da IA.
-- Escrito pela equipe no painel; lido pelas Edge Functions (service role) a cada resposta.
--  - escopo 'geral': vale para todas as conversas;
--  - escopo 'situacao': vale quando a conversa cai numa intenção (duvida, agendar...);
--  - escopo 'conversa': vale só para uma cliente.
create table public.salao_aprendizados (
  id uuid primary key default gen_random_uuid(),
  escopo text not null check (escopo in ('geral', 'situacao', 'conversa')),
  situacao text check (situacao in ('duvida', 'agendar', 'remarcar_ou_cancelar', 'reclamacao', 'outro')),
  conversa_id uuid references public.salao_conversas (id) on delete cascade,
  texto text not null check (char_length(texto) between 3 and 500),
  ativo boolean not null default true,
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  check ((escopo = 'situacao') = (situacao is not null)),
  check ((escopo = 'conversa') = (conversa_id is not null))
);
create index salao_aprendizados_ativos_idx on public.salao_aprendizados (ativo, criado_em);
create index salao_aprendizados_conversa_idx on public.salao_aprendizados (conversa_id);

alter table public.salao_aprendizados enable row level security;
create policy salao_aprendizados_le on public.salao_aprendizados
  for select to authenticated using (public.salao_eh_equipe());
create policy salao_aprendizados_inclui on public.salao_aprendizados
  for insert to authenticated with check (public.salao_eh_equipe());
create policy salao_aprendizados_altera on public.salao_aprendizados
  for update to authenticated using (public.salao_eh_equipe()) with check (public.salao_eh_equipe());
create policy salao_aprendizados_remove on public.salao_aprendizados
  for delete to authenticated using (public.salao_eh_equipe());
revoke all on public.salao_aprendizados from anon, authenticated;
grant select, insert, delete on public.salao_aprendizados to authenticated;
grant update (texto, ativo) on public.salao_aprendizados to authenticated;
