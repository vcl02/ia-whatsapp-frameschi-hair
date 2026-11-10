-- A equipe volta a LER as mensagens no painel (somente leitura), para ligar um
-- aprendizado às mensagens a que ele se refere. Substitui a restrição da migration
-- 20261108000000 (painel sem conteúdo).
-- Continua sem insert/update/delete: o painel não envia nem altera mensagem. Envio manual
-- segue só pela função salao-responder. Colunas que ficam de fora: erro (JSON da Meta).
grant select (id, conversa_id, direcao, autor, texto, criado_em)
  on public.salao_mensagens to authenticated;
-- A policy salao_mensagens_tipo_le (select só para a equipe) já existe e vale para estas colunas.
