import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.13';
import {
  type DepsExecucao,
  executarPedido,
  type PedidoParaExecutar,
  seCruzam,
} from '../functions/_shared/execucao.ts';
import {
  type AgendamentoPainel,
  corpoRemarcacao,
} from '../functions/_shared/painel_minhaagenda.ts';

const AGORA = new Date('2026-11-17T15:00:00Z');

const AG = {
  id: 77,
  date: '2026-11-19',
  startTime: '13:00',
  duration: 120,
  customerId: 5,
  customer: { phone1: '11999998888' },
  service: { name: 'Progressiva' },
  serviceId: 9,
  price: 450,
  userId: 486643,
  modelVersion: 3,
  services: [],
  appHasServices: [],
  containsProducts: false,
};

function pedido(p: Partial<PedidoParaExecutar> = {}): PedidoParaExecutar {
  return {
    id: 'pd1',
    conversaId: 'c1',
    waId: '5511999998888',
    tipo: 'cancelar',
    agendamentoSistemaId: 77,
    agendamentoId: null,
    novoData: null,
    novoHora: null,
    novoProfissional: null,
    ultimoInbound: new Date(AGORA.getTime() - 60 * 60_000),
    ...p,
  };
}

function montar(p: PedidoParaExecutar | null, dia: AgendamentoPainel[] = []) {
  const feito: string[] = [];
  const enviados: string[] = [];
  const estado = { reservado: false, concluido: '', liberado: '' };
  const deps: DepsExecucao = {
    repo: {
      carregar: () => Promise.resolve(p),
      reservar: () => {
        if (estado.reservado) return Promise.resolve(false);
        estado.reservado = true;
        return Promise.resolve(true);
      },
      concluir: (_id, r) => ((estado.concluido = r), Promise.resolve()),
      liberar: (_id, e) => ((estado.liberado = e), Promise.resolve()),
      acertarAgendamentoBot: () => Promise.resolve(),
    },
    painel: {
      agendamento: () => Promise.resolve({ ...AG }),
      cancelar: (id) => (feito.push(`cancelar ${id}`), Promise.resolve()),
      remarcar: (_a, n) => (
        feito.push(`remarcar ${n.data} ${n.hora} ${n.profissionalId}`), Promise.resolve()
      ),
      equipe: () =>
        Promise.resolve([{ id: 486643, nome: 'Bruna' }, {
          id: 1001243,
          nome: 'Alessandra',
        }]),
      agendaDoDia: () => Promise.resolve(dia),
    },
    enviar: (_w, t) => (
      enviados.push(t),
        Promise.resolve({ ok: true, wamid: 'w', httpStatus: 200, erro: null })
    ),
    registrarSaida: () => Promise.resolve(),
    log: () => {},
    agora: () => AGORA,
  };
  return { deps, feito, enviados, estado };
}

Deno.test('cancelar: apaga no Minha Agenda, avisa a cliente e conclui', async () => {
  const t = montar(pedido());
  const r = await executarPedido(t.deps, 'pd1');
  assert(r.ok);
  assertEquals(t.feito, ['cancelar 77']);
  assertStringIncludes(t.enviados[0], 'cancelamento');
  assertStringIncludes(t.estado.concluido, 'Cancelado no Minha Agenda');
});

Deno.test('agendamento de outro telefone: não faz nada e libera o pedido', async () => {
  const t = montar(pedido({ waId: '5511911112222' }));
  const r = await executarPedido(t.deps, 'pd1');
  assertEquals(r.ok, false);
  assertEquals(t.feito, []);
  assertStringIncludes(t.estado.liberado, 'não é do telefone');
});

Deno.test('remarcar: confere o novo horário e faz o PUT com a profissional certa', async () => {
  const t = montar(
    pedido({
      tipo: 'remarcar',
      novoData: '2026-11-20',
      novoHora: '10:00',
      novoProfissional: 'bruna',
    }),
  );
  const r = await executarPedido(t.deps, 'pd1');
  assert(r.ok, r.mensagem);
  assertEquals(t.feito, ['remarcar 2026-11-20 10:00 486643']);
  assertStringIncludes(t.enviados[0], 'remarcado');
});

Deno.test('remarcar para horário ocupado: não mexe na agenda', async () => {
  const ocupado = {
    id: 99,
    data: '2026-11-20',
    inicio: '11:00',
    fim: '12:00',
    profissionalId: 486643,
    profissionalNome: 'Bruna',
    servicoId: 1,
    servico: 'Escova',
    preco: 50,
    clienteNome: 'X',
    telefones: [],
  };
  const t = montar(
    pedido({
      tipo: 'remarcar',
      novoData: '2026-11-20',
      novoHora: '10:00', // 2 h de duração: cruza com 11:00
      novoProfissional: 'Bruna',
    }),
    [ocupado],
  );
  const r = await executarPedido(t.deps, 'pd1');
  assertEquals(r.ok, false);
  assertEquals(t.feito, []);
  assertStringIncludes(r.mensagem, 'ocupado');
});

Deno.test('pedido sem agendamento do sistema ou já resolvido: não executa', async () => {
  assertEquals((await executarPedido(montar(null).deps, 'x')).ok, false);
  const t = montar(pedido({ agendamentoSistemaId: null }));
  assertStringIncludes((await executarPedido(t.deps, 'pd1')).mensagem, 'automaticamente');
  assertEquals(t.feito, []);
});

Deno.test('fora da janela de 24 h: faz, mas avisa que a cliente não foi avisada', async () => {
  const t = montar(pedido({ ultimoInbound: new Date(AGORA.getTime() - 30 * 3600_000) }));
  const r = await executarPedido(t.deps, 'pd1');
  assert(r.ok);
  assertEquals(t.enviados, []);
  assertStringIncludes(r.mensagem, 'NÃO foi avisada');
});

Deno.test('seCruzam e corpo da remarcação', () => {
  assert(seCruzam('10:00', 120, '11:00', '12:00'));
  assert(!seCruzam('10:00', 60, '11:00', '12:00'));
  const c = corpoRemarcacao(AG, { data: '2026-11-20', hora: '10:00', profissionalId: 1 });
  assertEquals(c.date, '2026-11-20');
  assertEquals(c.userId, 1);
  assertEquals(c.modelVersion, 3);
  assertEquals(c.items, [{ serviceId: 9, price: 450 }]);
  let recusou = false;
  try {
    corpoRemarcacao({ ...AG, services: [{}, {}] }, {
      data: '2026-11-20',
      hora: '10:00',
      profissionalId: 1,
    });
  } catch {
    recusou = true;
  }
  assert(recusou);
});

Deno.test('origem IA: texto de cancelamento lembra o sinal, resultado marcado e avisada=true', async () => {
  const t = montar(pedido());
  const r = await executarPedido(t.deps, 'pd1', { origem: 'ia' });
  assert(r.ok && r.avisada);
  assertStringIncludes(t.enviados[0], 'foi cancelado');
  assertStringIncludes(t.enviados[0], 'sinal de 20% não é devolvido');
  assertStringIncludes(t.estado.concluido, 'Feito pela IA.');
});

Deno.test('origem painel: texto da Bruna, sem a frase do sinal e sem marca de IA', async () => {
  const t = montar(pedido());
  const r = await executarPedido(t.deps, 'pd1');
  assertStringIncludes(t.enviados[0], 'A Bruna confirmou o cancelamento');
  assertEquals(t.enviados[0].includes('sinal'), false);
  assertEquals(t.estado.concluido.startsWith('Feito pela IA'), false);
  assert(r.ok);
});
