-- Cópia do agendamento guardada antes de a IA (ou o botão do painel) cancelar ou remarcar,
-- para dar para marcar de novo igual se foi engano. Só o necessário: sem CPF, e-mail,
-- endereço ou data de nascimento. Some junto com a conversa (retenção de 12 meses).
-- Também guarda o dia e a hora do agendamento do pedido, para fechar o pedido sozinho
-- quando a Bruna resolver direto no Minha Agenda. Só a service role escreve; a equipe lê.
alter table public.salao_pedidos
  add column agendamento_data date,
  add column agendamento_hora text,
  add column copia_agendamento jsonb;
