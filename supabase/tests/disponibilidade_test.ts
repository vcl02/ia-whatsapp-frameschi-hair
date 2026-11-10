import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'jsr:@std/assert@1.0.13';
import {
  type ArmazemSessao,
  ConsultaMinhaAgenda,
  FalhaConsulta,
  hojeSaoPaulo,
  IDENTIDADE,
  lerProfissionais,
  lerVagas,
  type Sessao,
  validarData,
} from '../functions/_shared/disponibilidade.ts';

// Formatos reais capturados em 2026-11-07 (resumidos).
const PROFISSIONAIS = [{
  listEmployeeInfo: [
    { id: 1001243, name: 'Alessandra ', workScheduleDTO: {} },
    { id: 486643, name: 'Bruna Stefani frameschi ', workScheduleDTO: {} },
  ],
  serviceInfo: { id: 5732343, name: 'Banho de Lua' },
}];
const VAGAS = {
  listAppointmentAvailabilityDTO: [{ startTime: '09:00', endTime: '09:30' }, {
    startTime: '11:00',
    endTime: '11:30',
  }],
  holiday: false,
  employeesWithAvailableTimeForTheService: [],
};

Deno.test('lê profissionais e vagas', () => {
  assertEquals(lerProfissionais(PROFISSIONAIS), [{ id: 1001243, nome: 'Alessandra' }, {
    id: 486643,
    nome: 'Bruna Stefani frameschi',
  }]);
  assertEquals(lerVagas(VAGAS), {
    vagas: [{ inicio: '09:00', fim: '09:30' }, { inicio: '11:00', fim: '11:30' }],
    feriado: false,
  });
  assertEquals(lerVagas({ holiday: true }).feriado, true);
  assertEquals(lerProfissionais(null), []);
});

Deno.test('valida a data pedida em relação a hoje em São Paulo', () => {
  const agora = new Date('2026-11-07T02:00:00Z'); // 06/11 23:00 em SP
  assertEquals(hojeSaoPaulo(agora), '2026-11-06');
  assertEquals(validarData('2026-11-10', 15, agora), null);
  assertStringIncludes(validarData('2026-11-05', 15, agora)!, 'já passou');
  assertStringIncludes(validarData('2026-11-30', 15, agora)!, '15 dias');
  assertStringIncludes(validarData('10/11/2026', 15, agora)!, 'formato');
});

class ArmazemMemoria implements ArmazemSessao {
  s: Sessao | null = null;
  ler() {
    return Promise.resolve(this.s);
  }
  gravar(s: Sessao | null) {
    this.s = s;
    return Promise.resolve();
  }
}

function fakeMinhaAgenda(opcoes: { recusarPrimeiroToken?: boolean } = {}) {
  const chamadas: string[] = [];
  let tokens = 0;
  const cadastros: unknown[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    chamadas.push(u.replace(/\?.*$/, ''));
    const resp = (corpo: unknown, status = 200) =>
      new Response(JSON.stringify(corpo), { status });
    if (u.includes('accounts:signUp')) {
      tokens++;
      return resp({
        idToken: `tok${tokens}`,
        refreshToken: `ref${tokens}`,
        expiresIn: '3600',
      });
    }
    if (u.includes('securetoken')) {
      return resp({ id_token: 'renovado', refresh_token: 'ref2', expires_in: '3600' });
    }
    if (u.includes('firebaseGuestSignUp')) {
      cadastros.push(JSON.parse(String(init?.body)));
      return resp({});
    }
    const auth = new Headers(init?.headers).get('authorization');
    if (opcoes.recusarPrimeiroToken && auth === 'Bearer tok1') return resp({}, 401);
    if (u.includes('availableEmployeesByService')) return resp(PROFISSIONAIS);
    if (u.includes('availableTimes')) {
      return resp(
        u.includes('employeeId=486643')
          ? VAGAS
          : { listAppointmentAvailabilityDTO: [], holiday: false },
      );
    }
    return resp({}, 404);
  }) as typeof fetch;
  return { f, chamadas, cadastros: () => cadastros };
}

Deno.test('primeira consulta: login, cadastro com a identidade fixa e horários por profissional', async () => {
  const fake = fakeMinhaAgenda();
  const armazem = new ArmazemMemoria();
  const c = new ConsultaMinhaAgenda('KEY', armazem, fake.f, () => 1_000_000);
  const texto = await c.horarios(5732343, '2026-11-10');
  assertStringIncludes(texto, 'Bruna: 09:00, 11:00');
  assertStringIncludes(texto, 'Alessandra: sem horários livres');
  assertEquals(fake.cadastros().length, 1);
  const cad = fake.cadastros()[0] as Record<string, unknown>;
  assertEquals([cad.name, cad.phone, cad.countryIso, cad.slug], [
    IDENTIDADE.name,
    '11988973181',
    'BR',
    'Brunaframeschihair',
  ]);
  assertEquals(armazem.s?.cadastrado, true);
});

Deno.test('reaproveita a sessão e usa cache de 5 min', async () => {
  const fake = fakeMinhaAgenda();
  const armazem = new ArmazemMemoria();
  let t = 1_000_000;
  const c = new ConsultaMinhaAgenda('KEY', armazem, fake.f, () => t);
  await c.horarios(5732343, '2026-11-10');
  const antes = fake.chamadas.length;
  await c.horarios(5732343, '2026-11-10'); // cache
  assertEquals(fake.chamadas.length, antes);
  t += 6 * 60_000;
  await c.horarios(5732343, '2026-11-10'); // passou o cache: consulta de novo, sem novo login
  assertEquals(fake.chamadas.filter((u) => u.includes('accounts:signUp')).length, 1);
  assertEquals(fake.cadastros().length, 1);
});

Deno.test('token perto de vencer é renovado sem novo cadastro', async () => {
  const fake = fakeMinhaAgenda();
  const armazem = new ArmazemMemoria();
  armazem.s = {
    idToken: 'velho',
    refreshToken: 'ref',
    expiraEm: 1_000_000 + 30_000,
    cadastrado: true,
  };
  const c = new ConsultaMinhaAgenda('KEY', armazem, fake.f, () => 1_000_000);
  await c.horarios(5732343, '2026-11-10');
  assertEquals(armazem.s?.idToken, 'renovado');
  assertEquals(fake.cadastros().length, 0);
});

Deno.test('sessão recusada (401): faz login novo uma vez e segue', async () => {
  const fake = fakeMinhaAgenda({ recusarPrimeiroToken: true });
  const c = new ConsultaMinhaAgenda('KEY', new ArmazemMemoria(), fake.f, () => 1_000_000);
  const texto = await c.horarios(5732343, '2026-11-10');
  assertStringIncludes(texto, '09:00');
  assertEquals(fake.cadastros().length, 2); // um por usuário anônimo
});

Deno.test('erro do Minha Agenda vira FalhaConsulta', async () => {
  const f = (async (url: string) =>
    String(url).includes('signUp')
      ? new Response(
        JSON.stringify({ idToken: 't', refreshToken: 'r', expiresIn: '3600' }),
      )
      : new Response('{}', {
        status: String(url).includes('GuestSignUp') ? 200 : 500,
      })) as typeof fetch;
  const c = new ConsultaMinhaAgenda('KEY', new ArmazemMemoria(), f, () => 1);
  await assertRejects(() => c.horarios(1, '2026-11-10'), FalhaConsulta, 'HTTP 500');
});

Deno.test('primeiro nome da profissional', async () => {
  const { primeiroNome } = await import('../functions/_shared/disponibilidade.ts');
  assertEquals(primeiroNome('Bruna Stefani frameschi '), 'Bruna');
  assertEquals(primeiroNome('alessandra'), 'Alessandra');
});
