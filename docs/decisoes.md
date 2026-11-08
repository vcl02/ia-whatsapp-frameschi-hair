# Decisões

Registro curto. Data = quando foi decidido ou registrado aqui.

## 2026-11-05 — Fase 1: webhook + LLM numa Edge Function do Supabase
- Sem servidor próprio. Webhook, bot e envio manual são Edge Functions.
- A resposta HTTP à Meta sai logo depois de gravar; a geração com a LLM
  roda em segundo plano (`EdgeRuntime.waitUntil`).
- Dedupe por `wamid` (a Meta pode reenviar o mesmo evento).

## 2026-11-05 — Número do salão: migrar o número da tia para a API
- Se for coexistência como no número do Victor, ela mantém o app no celular.
- Antes de migrar: confirmar se ela usa os lembretes por WhatsApp do
  Minha Agenda, que podem parar de funcionar.

## 2026-11-05 — Agenda: link público do Minha Agenda
- Sem API pública conhecida. Fase 1 só manda o link.
- Fase 2 (depois): robô Playwright num servidor pequeno, só após a cliente
  confirmar um resumo. Passos/seletores versionados no banco, ativados só
  depois de passar no monitoramento. Plano B: manda o link e avisa.
- Captcha: não usar serviço de quebra. Pedir API ao suporte ou ficar no plano B.

## 2026-11-05 — LLM: Claude pela API da Anthropic
- Modelo `claude-sonnet-5-5`, esforço `medium` (decisão do Victor em
  2026-11-06, por custo; antes era `claude-opus-5-5` em `low`).
- Saída estruturada (JSON com `resposta`, `passar_para_humano`, `motivo`,
  `intencao`), validada no código. Se falhar, recusar ou cortar: passa
  para humano.
- Fallback do lado do servidor (`fallbacks: "default"`) ligado: se o
  modelo recusar, a API tenta outro modelo.
- A LLM só recebe os dados de `salao.ts` e as últimas 20 mensagens.
- Mensagem que não é texto (áudio, imagem) não vai para a LLM: passa para humano.

## 2026-11-05 — Dados e LGPD
- Gravado: número, nome do perfil, texto das mensagens, statuses.
  Mídia não é baixada.
- RLS ligado em todas as tabelas; leitura só para `salao_equipe`; a tela só
  pode alterar as colunas de pausa.
- Logs não levam texto de mensagem.
- Retenção: 12 meses sem movimento -> conversa apagada (função
  `salao_limpar_antigos`, agendada no pg_cron pela migration).
- O bot se apresenta como assistente virtual na primeira resposta.

## 2026-11-06 — Testes dentro do projeto Supabase do hub (temporário)
- Motivo: a organização está no plano free com 2 projetos ativos (hub e
  gestao-ammi). Pelo que sei, o free permite 2 projetos ativos (não conferido).
- Isolamento: tabelas `salao_*`, funções `salao-*`, secrets `SALAO_*`,
  chave da Anthropic própria do bot.
- Riscos aceitos só para teste: secrets do projeto são visíveis para
  todas as funções (as do hub enxergariam as do bot e vice-versa); o login
  da tela usa o Auth do hub.
- Por isso, durante os testes, **só o Victor** usa a tela (conta que já
  existe no hub). Não criar conta da Bruna no hub: as políticas
  `*_somente_dono` do hub deixariam uma conta nova gravar linhas próprias
  nas tabelas pessoais (sem ler as do Victor — verificado nas políticas).
- Antes de clientes reais: projeto próprio do salão (pausar um projeto,
  ou plano pago). A migração é: aplicar a mesma migration lá, copiar
  `salao_servicos`, trocar URL do webhook na Meta.

## 2026-11-06 — Serviços e preços no banco
- Tabela `salao_servicos`, editada pela aba Serviços da tela. Mudar preço
  não exige deploy.
- Depois: importar do site do Minha Agenda por script (adiado).

## 2026-11-06 — Aviso à equipe por e-mail
- Troca do aviso por WhatsApp (exigiria modelo aprovado fora da janela de 24 h).
- Provedor: Resend (sugestão minha; trocar = mudar só `enviarEmailResend`).
- O e-mail leva nome do perfil, número e motivo; não leva texto da conversa.
- Sem chave configurada, o aviso só vai para o log; o resto funciona.

## 2026-11-06 — Coexistência
- O número do Victor, registrado na API, continua 100% no app (relato).
- O número da Bruna vai para a API mantendo o app no celular.
- Resposta dada pelo app pausa o bot da conversa (evento de eco).

## 2026-11-07 — Espelho do Minha Agenda
- O Minha Agenda é a fonte da verdade. A Bruna continua usando só ele; o bot
  funciona "apesar dela".
- Função `salao-sincronizar`, uma vez por dia (pg_cron, 06:07 de Brasília), lê
  `apionline.maapp.com.br/companyProfiles/Brunaframeschihair` (JSON público).
- Espelho 100%: nomes, preços, durações e "a partir de" (campo
  `onlineSchedulingPriceDisplay = STARTS_AT`) exatamente como lá. De-para pelo
  id do serviço (`origem_id`). Serviço novo entra ativo; o que some é
  desativado (não apagado). Cadastros manuais antigos são apagados.
- Também espelha o horário (`workSchedule`) e as regras de agendamento
  (antecedência mínima, prazo máximo, política de cancelamento e aviso de
  tolerância de atraso), na tabela `salao_info`.
- O endereço NÃO é espelhado: o certo é Rua Ettore Andreazza, 691 (o Minha
  Agenda mostra outro).
- Proteções: resposta vazia ou com menos da metade dos serviços não altera
  nada; e-mail de resumo quando há mudança ou falha; a função não exige JWT
  (lê só dados públicos) e recusa rodar de novo em menos de 30 min.
- A aba Serviços da tela ficou só leitura.

## 2026-11-07 — Consulta de horários livres no Minha Agenda
- Ferramenta `consultar_horarios(servico_id, data)` oferecida ao Claude; ele só
  chama quando a cliente pergunta por vaga num dia. Até 3 consultas por resposta.
- Fluxo igual ao da página: login anônimo no Firebase do Minha Agenda (chave
  pública em `SALAO_MA_FIREBASE_KEY`), cadastro de convidada com identidade FIXA
  (Bruna Frameschi, 11988973181, pedida pelo Victor), `availableEmployeesByService`
  e `availableTimes` por profissional. Nunca usa dados de cliente; nunca agenda.
- Sessão guardada em `salao_sessao_minhaagenda` (só service role), renovada
  sozinha; 401/403 => login novo uma vez. Cache de 5 min por serviço+data.
- Validações: serviço precisa estar na lista ativa; data de hoje até 15 dias.
  Falha na consulta => o bot manda o link (nunca inventa horário).
- Risco aceito: API exige sessão e não é documentada; pode mudar sem aviso.
- Equipe no prompt: Alessandra (manicure e pedicure), Bruna (cabelo, massagem e
  o resto).

## 2026-11-07 — Agendamento pelo bot (com confirmação da cliente; confirmação por "SIM" substituída em 2026-11-08, veja abaixo)
- Bruna de acordo; aviso por e-mail ao Victor a cada agendamento.
- Duas etapas: `propor_agendamento` confere a vaga (sem cache) e grava uma
  proposta em `salao_agendamentos` (vale 10 min; nova proposta substitui a
  anterior). `confirmar_agendamento` só agenda se houver proposta pendente E a
  última mensagem da cliente for uma confirmação clara (`ehConfirmacao`). A
  trava está no código, não só no prompt.
- Antes de agendar, confere de novo se o horário está livre.
- O agendamento usa cadastro de convidada com o NOME DO PERFIL do WhatsApp
  (decisão do Victor) e o telefone da conversa, como se a cliente agendasse
  pelo site. Comentário: "Agendado pelo assistente virtual do WhatsApp".
- Limite: 1 agendamento pelo bot por conversa a cada 24 h. Remarcar/cancelar:
  humano (o Minha Agenda não deixa a cliente cancelar sozinha).
- Falha no agendamento => link + passar para humano. `SALAO_AGENDAR=nao`
  desliga só o agendamento.

## 2026-11-08 — Sinal de 20% por Pix confirma o agendamento (substitui o "SIM")
- Pedido do Victor: em vez de "SIM", a cliente paga 20% por Pix e manda o
  comprovante; o sistema NÃO lê o comprovante, só vê que chegou imagem ou PDF.
- `propor_agendamento` grava a proposta (agora vale **30 min**) e devolve resumo,
  valor do sinal e chave Pix para a IA mandar. A IA não tem mais ferramenta para
  agendar (`confirmar_agendamento` e `ehConfirmacao` foram removidos): quem agenda
  é `receberComprovante` (código), quando chega `image` ou `document` numa
  conversa com proposta pendente.
- Sinal = 20% do preço; "a partir de" usa o valor mínimo e a IA avisa que a Bruna
  confirma o valor final. Sem valor legível ou sem chave Pix configurada: não
  propõe, chama a Bruna.
- Chave Pix e titular ficam em secrets do Supabase (`SALAO_PIX_CHAVE`,
  `SALAO_PIX_TITULAR`), não no repositório.
- Limite conhecido: qualquer imagem/PDF conta. A Bruna precisa conferir o Pix no
  banco; o e-mail de cada agendamento pede isso. A IA nunca diz "pagamento
  confirmado".
- Prazo vencido, horário ocupado, erro, ou 2º agendamento no dia: o comprovante
  vai para a equipe (pode ter dinheiro envolvido). Segundo comprovante logo depois
  de agendar é ignorado. Imagem sem proposta pendente continua chamando a equipe.
- Reconsulta a vaga ao propor e de novo ao receber o comprovante.
