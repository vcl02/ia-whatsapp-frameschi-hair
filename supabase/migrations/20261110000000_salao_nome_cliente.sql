-- Nome da cliente editável no painel. Fica separado de nome_perfil (que vem do
-- WhatsApp e é atualizado a cada mensagem), para o nome editado nunca ser
-- sobrescrito. Vazio = usa o nome do perfil.
alter table public.salao_conversas
  add column if not exists nome_cliente text
  check (nome_cliente is null or char_length(nome_cliente) between 1 and 80);

grant select (nome_cliente) on public.salao_conversas to authenticated;
grant update (nome_cliente) on public.salao_conversas to authenticated;
