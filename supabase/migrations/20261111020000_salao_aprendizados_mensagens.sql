-- Liga um aprendizado às mensagens a que ele se refere (até 10).
--  - mensagens_ids: referência, para o painel reabrir a conversa;
--  - exemplo: cópia do texto dessas mensagens [{"autor":"cliente|bot|humano","texto":"..."}],
--    na ordem da conversa. É isto que a IA lê junto com a nota ("nessa situação, faça X").
--    Fica copiado de propósito: o aprendizado não some quando a conversa for apagada
--    pela retenção de 12 meses.
-- Pode rodar de novo: usa "if not exists". Os grants de select e insert já cobrem as colunas.
alter table public.salao_aprendizados
  add column if not exists mensagens_ids uuid[] not null default '{}'
  check (cardinality(mensagens_ids) <= 10);
alter table public.salao_aprendizados
  add column if not exists exemplo jsonb not null default '[]'
  check (jsonb_typeof(exemplo) = 'array' and jsonb_array_length(exemplo) <= 10);
