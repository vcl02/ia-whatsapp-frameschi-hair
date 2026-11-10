-- Modelo, esforço e limites de respostas da IA, editados no painel (parte técnica).
-- O bot lê estes valores a cada mensagem. Só valores conhecidos são aceitos.
alter table public.salao_controle
  add column modelo text not null default 'claude-sonnet-5-5'
    check (modelo in ('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1')),
  add column esforco text not null default 'medium'
    check (esforco in ('low', 'medium', 'high')),
  add column limite_conversa_hora int not null default 20
    check (limite_conversa_hora between 1 and 200),
  add column limite_global_dia int not null default 300
    check (limite_global_dia between 1 and 5000);

grant update (modelo, esforco, limite_conversa_hora, limite_global_dia)
  on public.salao_controle to authenticated;
