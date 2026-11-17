import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.13';
import {
  type AgendamentoPainel,
  type CacheAgenda,
  lerAgendaDoDia,
  lerCredenciaisPainel,
  mesmoTelefone,
  PainelMinhaAgenda,
  proximasDatas,
  type TokenPainel,
} from '../functions/_shared/painel_minhaagenda.ts';
import { contextoDaAgendaReal, type Proposta } from '../functions/_shared/agendamento.ts';

const DIA = {
  employeeIdToAppointments: {
    '486643': [
      {
        id: 10,
        userId: 486643,
        date: '2026-11-19',
        startTime: '13:00',
        endTime: '15:00',
        customer: { name: 'Ana Souza', phone1: '11999998888', phone2: null },
        service: { name: 'Progressiva' },
        user: { name: 'Bruna Stefani' },
        price: 450,
      },
    ],
    '1001243': [
      {
        id: 11,
        userId: 1001243,
        date: '2026-11-19',
        startTime: '09:00',
        endTime: '10:00',
        customer: { name: 'Bia', phone1: '1188887777' },
        service: { name: 'Manicure' },
        user: { name: 'Alessandra' },
        price: 40,
      },
    ],
  },
};

Deno.test('lerAgendaDoDia: só os campos usados, em ordem de horário', () => {
  const a = lerAgendaDoDia(DIA);
  assertEquals(a.map((x) => x.id), [11, 10]);
  assertEquals(a[1], {
    id: 10,
    data: '2026-11-19',
    inicio: '13:00',
    fim: '15:00',
    profissionalId: 486643,
    profissionalNome: 'Bruna',
    servicoId: null,
    servico: 'Progressiva',
    preco: 450,
    clienteNome: 'Ana Souza',
    telefones: ['11999998888'],
  });
  assertEquals(lerAgendaDoDia({}), []);
});

Deno.test('mesmoTelefone: compara final e DDD, tolera 55 e cadastro sem o 9', () => {
  assert(mesmoTelefone('5511999998888', ['11999998888']));
  assert(mesmoTelefone('5511999998888', ['5511999998888']));
  assert(mesmoTelefone('5511999998888', ['1199998888'])); // sem o 9
  assert(mesmoTelefone('5511999998888', ['99998888'])); // sem DDD
  assert(!mesmoTelefone('5511999998888', ['21999998888'])); // outro DDD
  assert(!mesmoTelefone('5511999998888', ['11999997777']));
});

Deno.test('lerCredenciaisPainel: exige as três e tira o "Basic "', () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];
  assertEquals(lerCredenciaisPainel(env({ SALAO_MA_USUARIO: 'a' })), null);
  assertEquals(
    lerCredenciaisPainel(
      env({ SALAO_MA_USUARIO: 'a', SALAO_MA_SENHA: 'b', SALAO_MA_CLIENTE: 'Basic xyz' }),
    ),
    { usuario: 'a', senha: 'b', cliente: 'xyz' },
  );
});

function montar(tokenGuardado: TokenPainel | null, recusarPrimeiro = false) {
  const chamadas: string[] = [];
  let guardado = tokenGuardado;
  const cacheMap = new Map<string, AgendamentoPainel[]>();
  const cache: CacheAgenda = {
    ler: (d) => Promise.resolve(cacheMap.get(d) ?? null),
    gravar: (d, i) => (cacheMap.set(d, i), Promise.resolve()),
  };
  let recusar = recusarPrimeiro;
  const fetchFalso = (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    chamadas.push(`${u.replace('https://api.minhaagendaapp.com.br', '')} ${auth}`);
    if (u.includes('/oauth/token')) {
      return Promise.resolve(
        Response.json({ access_token: 'novo', expires_in: 2592000 }),
      );
    }
    if (recusar && auth === 'Bearer velho') {
      recusar = false;
      return Promise.resolve(new Response('', { status: 401 }));
    }
    if (u.includes('/employees')) {
      return Promise.resolve(Response.json([{ id: 486643 }, { id: 1001243 }]));
    }
    return Promise.resolve(Response.json(DIA));
  };
  const painel = new PainelMinhaAgenda(
    { usuario: 'u', senha: 's', cliente: 'abc' },
    {
      ler: () => Promise.resolve(guardado),
      gravar: (t) => ((guardado = t), Promise.resolve()),
    },
    cache,
    fetchFalso as typeof fetch,
    () => 0,
  );
  return { painel, chamadas, guardado: () => guardado };
}

Deno.test('painel: reaproveita o token guardado e usa o cache do dia', async () => {
  const t = montar({ token: 'velho', expiraEm: 10 * 24 * 60 * 60_000 });
  await t.painel.agendaDoDia('2026-11-19');
  await t.painel.agendaDoDia('2026-11-19');
  assertEquals(t.chamadas.filter((c) => c.includes('oauth')).length, 0);
  assertEquals(t.chamadas.filter((c) => c.includes('grouped')).length, 1);
  assertStringIncludes(t.chamadas[1], 'employeeIds=486643,1001243');
  assertStringIncludes(t.chamadas[1], 'Bearer velho');
});

Deno.test('painel: login com o Basic do cliente quando não há token ou ele foi recusado', async () => {
  const semToken = montar(null);
  await semToken.painel.agendaDoDia('2026-11-19');
  assertEquals(semToken.chamadas[0], '/oauth/token?isWeb=true Basic abc');
  assertEquals(semToken.guardado()?.token, 'novo');

  const recusado = montar({ token: 'velho', expiraEm: 10 * 24 * 60 * 60_000 }, true);
  await recusado.painel.agendaDoDia('2026-11-19');
  assert(recusado.chamadas.some((c) => c.startsWith('/oauth/token')));
  assertEquals(recusado.guardado()?.token, 'novo');
});

Deno.test('painel: daCliente filtra pelo telefone da conversa', async () => {
  const t = montar({ token: 'velho', expiraEm: 10 * 24 * 60 * 60_000 });
  const a = await t.painel.daCliente('5511999998888', ['2026-11-19']);
  assertEquals(a.map((x) => x.id), [10]);
});

Deno.test('proximasDatas', () => {
  assertEquals(proximasDatas('2026-11-30', 3), [
    '2026-11-30',
    '2026-12-01',
    '2026-12-02',
  ]);
});

function repoBot(ativo: Proposta | null) {
  const mudancas: string[] = [];
  return {
    mudancas,
    repo: {
      recente: () =>
        Promise.resolve(
          mudancas.length && ativo
            ? { ...ativo, status: 'cancelado_no_sistema', atualizadoEm: 0 }
            : null,
        ),
      agendadoAtivo: () => Promise.resolve(mudancas.length ? null : ativo),
      mudarStatus: (id: string, _de: string, para: string) => {
        mudancas.push(`${id}:${para}`);
        return Promise.resolve(true);
      },
    },
  };
}

const AGORA = new Date('2026-11-17T15:00:00Z');
const PROPOSTA: Proposta = {
  id: 'p1',
  conversaId: 'c1',
  servicoId: 1,
  servicoNome: 'Progressiva',
  profissionalId: 486643,
  profissionalNome: 'Bruna',
  data: '2026-11-18',
  hora: '13:00',
  preco: 'R$ 450,00',
  nomeCliente: 'Ana',
  expiraEm: 0,
  criadoEm: AGORA.getTime() - 60 * 60_000,
};

Deno.test('agenda real: lista os horários da cliente e acerta o agendamento do bot que sumiu', async () => {
  const b = repoBot(PROPOSTA); // marcado dia 18; no painel ela está no dia 19
  const painel = {
    daCliente: () => Promise.resolve(lerAgendaDoDia(DIA).filter((a) => a.id === 10)),
  };
  const t = await contextoDaAgendaReal(
    painel,
    b.repo,
    'c1',
    '5511999998888',
    AGORA,
    () => {},
  );
  assertStringIncludes(t, 'FONTE DA VERDADE');
  assertStringIncludes(t, 'Progressiva, quinta-feira, 19/11, às 13:00, com Bruna');
  assertStringIncludes(t, 'cancelar_ou_remarcar_agendamento');
  assertEquals(b.mudancas, ['p1:cancelado_no_sistema']);
  // o agendamento do bot que sumiu aparece uma vez só, como não estando mais na agenda
  assertEquals(t.split('NÃO está mais na agenda').length - 1, 1);
  assertStringIncludes(t, 'Progressiva, quarta-feira, 18/11, às 13:00');
  assertStringIncludes(t, 'NÃO chame a Bruna por causa disso');
});

Deno.test('agenda real: sem horário marcado avisa a IA; agendamento do bot que continua não muda', async () => {
  const vazio = await contextoDaAgendaReal(
    { daCliente: () => Promise.resolve([]) },
    repoBot(null).repo,
    'c1',
    '5511999998888',
    AGORA,
    () => {},
  );
  assertStringIncludes(vazio, 'NÃO tem nenhum horário marcado');
  assertStringIncludes(vazio, 'FONTE DA VERDADE');

  const b = repoBot({ ...PROPOSTA, data: '2026-11-19' });
  await contextoDaAgendaReal(
    { daCliente: () => Promise.resolve(lerAgendaDoDia(DIA)) },
    b.repo,
    'c1',
    '5511999998888',
    AGORA,
    () => {},
  );
  assertEquals(b.mudancas, []);
});
