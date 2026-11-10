import { assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1.0.13';
import {
  formatarDuracao,
  formatarPreco,
  horarioDeTrabalho,
  LeituraSuspeita,
  lerPerfil,
  planejar,
  type ServicoBanco,
} from '../functions/_shared/minhaagenda.ts';

const perfil = JSON.parse(
  await Deno.readTextFile(new URL('./fixtures/perfil_minhaagenda.json', import.meta.url)),
);

Deno.test('preço e duração no formato brasileiro', () => {
  assertEquals(formatarPreco(79.9, false), 'R$ 79,90');
  assertEquals(formatarPreco(150, true), 'a partir de R$ 150,00');
  assertEquals(formatarPreco(1350, false), 'R$ 1.350,00');
  assertEquals(formatarPreco(null, false), 'consultar');
  assertEquals(formatarDuracao(30), '30 min');
  assertEquals(formatarDuracao(60), '1 h');
  assertEquals(formatarDuracao(65), '1 h 5 min');
  assertEquals(formatarDuracao(1440), '24 h');
  assertEquals(formatarDuracao(null), null);
});

Deno.test('horário agrupa dias iguais e lista os fechados', () => {
  assertEquals(
    horarioDeTrabalho(perfil.workSchedule),
    'terça a sábado, das 8h às 12h e das 13h às 19h. Fechado: segunda e domingo.',
  );
  assertEquals(horarioDeTrabalho({}), null);
  assertEquals(
    horarioDeTrabalho({
      tueEnabled: true,
      tueStartTime1: '09:30',
      tueEndTime1: '18:00',
      thuEnabled: true,
      thuStartTime1: '09:30',
      thuEndTime1: '18:00',
    }),
    'terça, das 9h30 às 18h; quinta, das 9h30 às 18h. Fechado: segunda, quarta, sexta, sábado e domingo.',
  );
});

Deno.test("lê serviços espelhando nomes e o 'a partir de' do próprio sistema", () => {
  const p = lerPerfil(perfil);
  assertEquals(p.servicos.length, 5);
  const botox = p.servicos.find((s) => s.origem_id === 2409365)!;
  assertEquals(botox.nome, 'Botox (A partir de)'); // nome exatamente como no Minha Agenda
  assertEquals(botox.preco, 'a partir de R$ 150,00');
  const luzes = p.servicos.find((s) => s.origem_id === 3259817)!;
  assertEquals(luzes.preco, 'R$ 350,00'); // marcado como FIXED lá: espelha igual
  assertEquals(luzes.categoria, 'Tintura');
  assertEquals(p.servicos.find((s) => s.origem_id === 6789990)!.duracao, '1 h 5 min');
});

Deno.test('regras de agendamento: antecedência, prazo, cancelamento e aviso', () => {
  const r = lerPerfil(perfil).regras!;
  assertStringIncludes(r, 'pelo menos 24 h de antecedência');
  assertStringIncludes(r, 'até 15 dias à frente');
  assertStringIncludes(r, 'Cancelamentos em no máximo 24 horas antes');
  assertStringIncludes(r, 'Tolerância de atraso de 10 minutos');
});

function banco(p: Partial<ServicoBanco> & { id: string }): ServicoBanco {
  return {
    origem_id: null,
    nome: '',
    preco: '',
    duracao: null,
    categoria: null,
    a_partir_de: false,
    ativo: true,
    ordem: 0,
    ...p,
  };
}

Deno.test('primeira sincronização: insere tudo e apaga os cadastros manuais', () => {
  const site = lerPerfil(perfil).servicos;
  const plano = planejar([banco({ id: 'x1', nome: 'Cauterização' })], site);
  assertEquals(plano.inserir.length, 5);
  assertEquals(plano.apagarLegados, ['x1']);
  assertEquals(plano.atualizar.length, 0);
});

Deno.test('de-para pelo id: muda preço, nome, sai e volta', () => {
  const site = lerPerfil(perfil).servicos;
  const atuais = site.map((s, i) => banco({ id: `b${i}`, ...s, ativo: true }));
  // banco desatualizado: preço antigo, nome antigo, um a mais que saiu, um inativo que voltou
  atuais[0].preco = 'R$ 25,00';
  atuais[2].nome = 'Drenagem';
  atuais[3].ativo = false;
  atuais.push(
    banco({ id: 'velho', origem_id: 999, nome: 'Serviço antigo', ativo: true }),
  );
  const plano = planejar(atuais, site);
  assertEquals(plano.inserir.length, 0);
  assertEquals(plano.desativar, ['velho']);
  assertEquals(plano.atualizar.map((u) => u.id).sort(), ['b0', 'b2', 'b3']);
  assertEquals(plano.mudancas.some((m) => m.includes('preço R$ 25,00 → R$ 30,00')), true);
  assertEquals(
    plano.mudancas.some((m) => m.includes('nome "Drenagem" → "Drenagem Linfática"')),
    true,
  );
  assertEquals(
    plano.mudancas.some((m) => m.includes('Saiu do Minha Agenda: Serviço antigo')),
    true,
  );
});

Deno.test('sem mudança: nada a fazer', () => {
  const site = lerPerfil(perfil).servicos;
  const atuais = site.map((s, i) => banco({ id: `b${i}`, ...s, ativo: true }));
  const plano = planejar(atuais, site);
  assertEquals([
    plano.inserir.length,
    plano.atualizar.length,
    plano.desativar.length,
    plano.mudancas.length,
  ], [0, 0, 0, 0]);
});

Deno.test('leitura suspeita não muda nada', () => {
  const site = lerPerfil(perfil).servicos;
  const atuais = Array.from(
    { length: 20 },
    (_, i) => banco({ id: `b${i}`, origem_id: i + 1, nome: `s${i}` }),
  );
  assertThrows(() => planejar(atuais, []), LeituraSuspeita);
  assertThrows(() => planejar(atuais, site), LeituraSuspeita); // 5 de 20
});
