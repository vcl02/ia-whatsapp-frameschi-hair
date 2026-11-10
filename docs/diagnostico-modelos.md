# Diagnóstico: por que os modelos (templates) não chegam

## O que se sabe

- Relato: texto livre chega dentro da janela de 24 h; modelos não chegam.
- A API de envio responde 200 quando _aceita_ a mensagem. A entrega (ou a falha) vem
  depois, nos `statuses` do webhook. Sem webhook, o erro real não aparece. Por isso o
  primeiro passo é ter o webhook gravando statuses.

## Passo a passo (depois do deploy do webhook)

1. Enviar um modelo para um número de teste (o seu ou o da sua esposa). Exemplo de
   requisição (valores entre `<>` são seus; rode da sua máquina, não comite o token):
   ```
   curl -X POST "https://graph.facebook.com/<VERSAO>/<PHONE_NUMBER_ID>/messages" \
     -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","to":"<NUMERO>","type":"template",
          "template":{"name":"<NOME_DO_MODELO>","language":{"code":"<CODIGO_IDIOMA>"}}}'
   ```
   Guarde o `messages[0].id` (wamid) da resposta.
2. No Supabase, consultar:
   ```sql
   select * from salao_status where wamid = '<wamid>' order by recebido_em;
   select * from salao_falhas_de_envio limit 20;
   ```
   Ou abrir "Falhas de envio" na tela de conversas.
3. Pegar o `codigo`, `titulo` e `detalhes` do erro e conferir na tabela oficial de códigos
   de erro da Cloud API (documentação da Meta).

## Hipóteses (NÃO verificadas — servem só para orientar a leitura do erro)

- Modelo não aprovado, pausado ou de outra conta (WABA) que não a do número registrado.
- Nome ou código de idioma diferente do cadastrado (ex.: `pt_BR`).
- Quantidade de parâmetros diferente da definida no modelo.
- Conta sem forma de pagamento configurada (modelos são cobrados; texto livre dentro da
  janela de atendimento, segundo a Meta, não).
- Limites da Meta para modelos de marketing por destinatário.
- Restrição de país/conta semelhante ao erro 130497 já visto no número de teste.

Nenhuma dessas é diagnóstico. O diagnóstico é o código que vier no status.
