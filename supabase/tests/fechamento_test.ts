import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.13';
import {
  fecharPedidosResolvidos,
  type PedidoPendente,
} from '../functions/_shared/fechamento.ts';
import type { AgendamentoPainel } from '../functions/_shared/painel_minhaagenda.ts';

const AGORA = new Date('2026-11-17T15:00:00Z');

const ag = (id: number, data: string, inicio: string): AgendamentoPainel => ({
  id,
  data,
  inicio,
  fim: '15:00',
  profissionalId: 1,
  profissionalNome: 'Bruna',
  servicoId: 9,
  servico: 'Progressiva',
  preco: 450,
  clienteNome: 'Ana',
  telefones: [],
});

const pend = (p: Partial<PedidoPendente> = {}): PedidoPendente => ({
  id: 'pd1',
  tipo: 'cancelar',
  agendamentoSistemaId: 77,
  data: '2026-11-19',
  hora: '13:00',
  novoData: null,
  novoHora: null,
  ...p,
});

async function rodar(
  pedidos: PedidoPendente[],
  agenda: Record<string, AgendamentoPainel[]>,
  falhaEm?: string,
) {
  const fechados: string[] = [];
  const logs: string[] = [];
  const n = await fecharPedidosResolvidos({
    repo: {
      pendentes: () => Promise.resolve(pedidos),
      fechar: (id, r) => (fechados.push(`${id}: ${r}`), Promise.resolve()),
    },
    agendaDoDia: (d) =>
      d === falhaEm
        ? Promise.reject(new Error('painel fora'))
        : Promise.resolve(agenda[d] ?? []),
    log: (e) => void logs.push(e),
    agora: () => AGORA,
  });
  return { n, fechados, logs };
}

Deno.test('cancelamento: agendamento ainda na agenda continua pendente', async () => {
  const r = await rodar([pend()], { '2026-11-19': [ag(77, '2026-11-19', '13:00')] });
  assertEquals(r.n, 0);
});

Deno.test('cancelamento: sumiu da agenda, a Bruna cancelou lá: fecha sozinho', async () => {
  const r = await rodar([pend()], { '2026-11-19': [ag(5, '2026-11-19', '09:00')] });
  assertEquals(r.n, 1);
  assertStringIncludes(r.fechados[0], 'Fechado sozinho: o agendamento foi cancelado');
});

Deno.test('remarcação: aparece no novo dia, fecha dizendo para quando foi', async () => {
  const r = await rodar(
    [pend({ tipo: 'remarcar', novoData: '2026-11-20', novoHora: '10:00' })],
    { '2026-11-20': [ag(77, '2026-11-20', '10:00')] },
  );
  assertEquals(r.n, 1);
  assertStringIncludes(r.fechados[0], 'remarcado no Minha Agenda para');
  assertStringIncludes(r.fechados[0], '10:00');
});

Deno.test('remarcação no mesmo dia com outra hora: fecha', async () => {
  const r = await rodar(
    [pend({ tipo: 'remarcar', novoData: '2026-11-19', novoHora: '15:00' })],
    { '2026-11-19': [ag(77, '2026-11-19', '15:00')] },
  );
  assertEquals(r.n, 1);
  assertStringIncludes(r.fechados[0], 'às 15:00'.slice(2));
});

Deno.test('horário que já passou: fecha', async () => {
  const r = await rodar([pend({ data: '2026-11-10' })], {});
  assertEquals(r.n, 1);
  assertStringIncludes(r.fechados[0], 'já passou');
});

Deno.test('erro ao ler a agenda: não fecha nada e registra o erro', async () => {
  const r = await rodar([pend()], {}, '2026-11-19');
  assertEquals(r.n, 0);
  assertEquals(r.logs, ['erro_fechar_pedido']);
});

Deno.test('sem pedidos pendentes: nem lê a agenda', async () => {
  const r = await rodar([], {}, '2026-11-19');
  assertEquals(r.n, 0);
  assertEquals(r.logs, []);
});
