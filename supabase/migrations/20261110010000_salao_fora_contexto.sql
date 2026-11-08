-- Mensagens de conversas de teste trocadas com a IA pausada (conversa normal)
-- ficam marcadas e não entram no contexto da IA quando ela é religada.
alter table public.salao_mensagens
  add column if not exists fora_contexto boolean not null default false;
