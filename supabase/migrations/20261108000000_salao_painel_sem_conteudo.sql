-- Painel sem acesso ao conteúdo das conversas: a equipe logada só vê quem é a
-- conversa, se o bot está ativo e se precisa de atenção, e liga/desliga o bot.
-- Texto das mensagens e o motivo escrito pelo bot (que pode citar a mensagem)
-- ficam só para as Edge Functions (service role).

drop policy if exists salao_mensagens_le on public.salao_mensagens;
revoke select on public.salao_mensagens from authenticated;
-- A visão de falhas de envio (futuro painel de erros) só precisa do tipo da mensagem.
grant select (wamid, tipo) on public.salao_mensagens to authenticated;
create policy salao_mensagens_tipo_le on public.salao_mensagens
  for select to authenticated using (public.salao_eh_equipe());

revoke select on public.salao_conversas from authenticated;
grant select (id, wa_id, nome_perfil, bot_pausado, precisa_humano, atualizado_em)
  on public.salao_conversas to authenticated;
-- O update de pausa/retoma continua: bot_pausado, precisa_humano, motivo_humano.
