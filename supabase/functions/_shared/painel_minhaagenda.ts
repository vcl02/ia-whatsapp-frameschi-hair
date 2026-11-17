// Acesso ao PAINEL do Minha Agenda com o login da Bruna (agenda interna do salão).
// Autorizado pelo dono do Minha Agenda, com o pedido de não abusar: por isso
//  - o token (vale ~30 dias) fica guardado no banco e é reaproveitado;
//  - a agenda de cada dia fica em cache por alguns minutos (tabela salao_agenda_cache).
// Credenciais só em secrets: SALAO_MA_USUARIO, SALAO_MA_SENHA e SALAO_MA_CLIENTE
// (o valor do cabeçalho "Authorization: Basic" que o portal usa no login).
// Leitura: agenda do dia. Escrita (cancelar/remarcar): só a função salao-executar-pedido,
// depois que a Bruna aprova o pedido no painel do salão. A IA nunca escreve na agenda.

export const API_PAINEL = 'https://api.minhaagendaapp.com.br';

export interface CredenciaisPainel {
  usuario: string;
  senha: string;
  cliente: string; // base64 de "client:secret", sem o "Basic "
}

export function lerCredenciaisPainel(
  env: (n: string) => string | undefined,
): CredenciaisPainel | null {
  const usuario = env('SALAO_MA_USUARIO')?.trim();
  const senha = env('SALAO_MA_SENHA');
  const cliente = env('SALAO_MA_CLIENTE')?.trim().replace(/^Basic\s+/i, '');
  return usuario && senha && cliente ? { usuario, senha, cliente } : null;
}

export interface TokenPainel {
  token: string;
  expiraEm: number; // epoch ms
}

export interface ArmazemTokenPainel {
  ler(): Promise<TokenPainel | null>;
  gravar(t: TokenPainel | null): Promise<void>;
}

/** Agendamento da agenda interna, só com o que o bot usa (nada de CPF, e-mail, endereço). */
export interface AgendamentoPainel {
  id: number;
  data: string; // AAAA-MM-DD
  inicio: string; // HH:MM
  fim: string; // HH:MM
  profissionalId: number;
  profissionalNome: string;
  servicoId: number | null;
  servico: string;
  preco: number | null;
  clienteNome: string;
  telefones: string[]; // só dígitos
}

export interface CacheAgenda {
  /** Agenda do dia se foi lida há menos de `maxIdadeMs`; senão null. */
  ler(data: string, maxIdadeMs: number): Promise<AgendamentoPainel[] | null>;
  gravar(data: string, itens: AgendamentoPainel[]): Promise<void>;
}

export class FalhaPainel extends Error {}

/** Por quanto tempo a agenda de um dia lida do painel vale (evita chamadas repetidas). */
export const MAX_IDADE_CACHE_MS = 15 * 60_000;
/** Quantos dias à frente a IA enxerga da agenda da cliente (hoje incluso). */
export const DIAS_AGENDA_CLIENTE = 16;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const digitos = (v: unknown): string => str(v).replace(/\D/g, '');

const CABECALHOS = {
  accept: 'application/json, text/plain, */*',
  app_is_web: 'true',
  origin: 'https://portal.minhaagendaapp.com.br',
  referer: 'https://portal.minhaagendaapp.com.br/',
};

/** Resposta de `appointments/groupedByEmployeesOrRooms` -> agendamentos do dia. */
export function lerAgendaDoDia(json: unknown): AgendamentoPainel[] {
  const porProfissional = obj(obj(json).employeeIdToAppointments);
  const out: AgendamentoPainel[] = [];
  for (const lista of Object.values(porProfissional)) {
    for (const item of arr(lista)) {
      const a = obj(item);
      const c = obj(a.customer);
      if (typeof a.id !== 'number' || !str(a.date) || !str(a.startTime)) continue;
      out.push({
        id: a.id,
        data: str(a.date),
        inicio: str(a.startTime).slice(0, 5),
        fim: str(a.endTime).slice(0, 5),
        profissionalId: Number(a.userId),
        profissionalNome: str(obj(a.user).name).trim().split(/\s+/)[0] ?? '',
        servicoId: typeof a.serviceId === 'number' ? a.serviceId : null,
        servico: str(obj(a.service).name) || 'serviço',
        preco: typeof a.price === 'number' ? a.price : null,
        clienteNome: str(c.name).trim() || str(a.customerName).trim(),
        telefones: [c.phone1, c.phone2, c.phoneInternational]
          .map(digitos)
          .filter((d) => d.length >= 8),
      });
    }
  }
  return out.sort((x, y) => (x.data + x.inicio).localeCompare(y.data + y.inicio));
}

/**
 * O agendamento é deste telefone? Compara os 8 últimos dígitos e, quando os dois têm DDD,
 * o DDD também (cadastros antigos podem estar sem o 9 ou sem o 55).
 */
export function mesmoTelefone(waId: string, telefones: string[]): boolean {
  const alvo = waId.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const ddd = alvo.length >= 10 ? alvo.slice(0, 2) : null;
  return telefones.some((t0) => {
    const t = t0.replace(/^55(?=\d{10,11}$)/, '');
    if (t.slice(-8) !== alvo.slice(-8)) return false;
    const dddT = t.length >= 10 ? t.slice(0, 2) : null;
    return !ddd || !dddT || ddd === dddT;
  });
}

export class PainelMinhaAgenda {
  constructor(
    private cred: CredenciaisPainel,
    private armazem: ArmazemTokenPainel,
    private cache: CacheAgenda,
    private fetchFn: typeof fetch = fetch,
    private agora: () => number = () => Date.now(),
  ) {}

  private async login(): Promise<TokenPainel> {
    const r = await this.fetchFn(`${API_PAINEL}/oauth/token?isWeb=true`, {
      method: 'POST',
      headers: {
        ...CABECALHOS,
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${this.cred.cliente}`,
      },
      body: new URLSearchParams({
        username: this.cred.usuario,
        password: this.cred.senha,
        grant_type: 'password',
      }).toString(),
    });
    const j = obj(await r.json().catch(() => ({})));
    if (!r.ok || typeof j.access_token !== 'string') {
      throw new FalhaPainel(`login no painel do Minha Agenda falhou (HTTP ${r.status})`);
    }
    const t = {
      token: j.access_token,
      expiraEm: this.agora() + Number(j.expires_in ?? 3600) * 1000,
    };
    await this.armazem.gravar(t);
    return t;
  }

  /** Reaproveita o token guardado; só faz login se faltar menos de 1 dia para vencer. */
  private async token(forcarNovo = false): Promise<string> {
    const t = forcarNovo ? null : await this.armazem.ler();
    if (t && t.expiraEm - this.agora() > 24 * 60 * 60_000) return t.token;
    return (await this.login()).token;
  }

  private get(caminho: string): Promise<unknown> {
    return this.chamar('GET', caminho);
  }

  private async chamar(
    metodo: 'GET' | 'PUT' | 'DELETE',
    caminho: string,
    corpo?: unknown,
  ): Promise<unknown> {
    for (const novo of [false, true]) {
      const r = await this.fetchFn(`${API_PAINEL}${caminho}`, {
        method: metodo,
        headers: {
          ...CABECALHOS,
          authorization: `Bearer ${await this.token(novo)}`,
          ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
      if (r.status === 401 && !novo) {
        await r.body?.cancel();
        continue; // token recusado (senha trocada?): tenta 1x com login novo
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new FalhaPainel(`painel do Minha Agenda respondeu HTTP ${r.status}`);
      }
      if (r.status === 204) return null;
      const texto = await r.text();
      return texto ? JSON.parse(texto) : null;
    }
    throw new FalhaPainel('painel do Minha Agenda recusou o login');
  }

  private listaProfissionais: Array<{ id: number; nome: string }> | null = null;

  /** Profissionais (id e primeiro nome), lidos uma vez por execução da função. */
  async equipe(): Promise<Array<{ id: number; nome: string }>> {
    if (this.listaProfissionais) return this.listaProfissionais;
    const lista = arr(await this.get('/employees?professionalOnly=true')).flatMap((e) => {
      const x = obj(e);
      return typeof x.id === 'number'
        ? [{ id: x.id, nome: str(x.name).trim().split(/\s+/)[0] ?? '' }]
        : [];
    });
    if (lista.length === 0) throw new FalhaPainel('painel sem profissionais');
    this.listaProfissionais = lista;
    return lista;
  }

  async profissionais(): Promise<number[]> {
    return (await this.equipe()).map((p) => p.id);
  }

  /** Agendamento completo, como o painel devolve (para conferir e montar a remarcação). */
  async agendamento(id: number): Promise<Obj> {
    const j = obj(await this.get(`/appointments/${id}`));
    if (j.id !== id) throw new FalhaPainel('agendamento não encontrado no painel');
    return j;
  }

  /** Apaga o agendamento (é o que o botão "excluir" do painel faz). */
  async cancelar(id: number, data: string): Promise<void> {
    await this.chamar('DELETE', `/appointments/${id}`);
    await this.agendaDoDia(data, 0); // atualiza o cache do dia
  }

  /** Muda dia, horário e profissional, mantendo o resto do agendamento. */
  async remarcar(
    atual: Obj,
    novo: { data: string; hora: string; profissionalId: number },
  ): Promise<void> {
    await this.chamar(
      'PUT',
      `/appointments/${atual.id}`,
      corpoRemarcacao(atual, novo),
    );
    await this.agendaDoDia(str(atual.date), 0);
    if (novo.data !== str(atual.date)) await this.agendaDoDia(novo.data, 0);
  }

  /** Agenda do dia (todas as profissionais), com cache de `maxIdadeMs`. */
  async agendaDoDia(
    data: string,
    maxIdadeMs = MAX_IDADE_CACHE_MS,
  ): Promise<AgendamentoPainel[]> {
    const guardada = await this.cache.ler(data, maxIdadeMs);
    if (guardada) return guardada;
    const profissionais = await this.profissionais();
    const json = await this.get(
      `/appointments/groupedByEmployeesOrRooms?date=${data}&employeeIds=${
        profissionais.join(',')
      }&roomIds=`,
    );
    if (!('employeeIdToAppointments' in obj(json))) {
      throw new FalhaPainel('agenda do painel veio num formato inesperado');
    }
    const itens = lerAgendaDoDia(json);
    await this.cache.gravar(data, itens);
    return itens;
  }

  /** Agendamentos deste telefone de `datas` (uma leitura por dia, com cache). */
  async daCliente(waId: string, datas: string[]): Promise<AgendamentoPainel[]> {
    const out: AgendamentoPainel[] = [];
    for (const d of datas) {
      for (const a of await this.agendaDoDia(d)) {
        if (mesmoTelefone(waId, a.telefones)) out.push(a);
      }
    }
    return out;
  }
}

/**
 * Corpo do PUT de remarcação, no formato que o portal manda (visto num HAR de 2026-11-16).
 * Recusa agendamento com mais de um serviço ou com produto: esses a Bruna faz à mão.
 */
export function corpoRemarcacao(
  a: Obj,
  novo: { data: string; hora: string; profissionalId: number },
): Record<string, unknown> {
  const servicos = arr(a.services).length || arr(a.appHasServices).length;
  if (servicos > 1 || a.containsProducts === true || arr(a.appHasProducts).length) {
    throw new FalhaPainel(
      'agendamento com mais de um serviço ou com produto: remarque no Minha Agenda',
    );
  }
  if (typeof a.serviceId !== 'number' || typeof a.id !== 'number') {
    throw new FalhaPainel('agendamento sem serviço identificado');
  }
  return {
    id: a.id,
    date: novo.data,
    startTime: novo.hora,
    duration: a.duration,
    customerId: a.customerId,
    accountsReceivableId: a.accountsReceivableId ?? null,
    paymentMethod: a.paymentMethod ?? null,
    comments: a.comments ?? '',
    colorId: a.colorId ?? null,
    materialCost: a.materialCost ?? null,
    reminder: a.reminder ?? false,
    userId: novo.profissionalId,
    roomId: a.roomId ?? null,
    appointmentRepeatInfoForm: null,
    discount: a.discount ?? null,
    discountInPercentage: a.discountInPercentage ?? false,
    tag: a.tag ?? null,
    modelVersion: a.modelVersion,
    loyaltyCardCustomerId: a.loyaltyCardCustomerId ?? null,
    items: [{ serviceId: a.serviceId, price: a.price }],
    productItems: [],
  };
}

/** Telefones do cadastro da cliente de um agendamento completo (só dígitos). */
export function telefonesDoAgendamento(a: Obj): string[] {
  const c = obj(a.customer);
  return [c.phone1, c.phone2, c.phoneInternational].map(digitos).filter((d) =>
    d.length >= 8
  );
}

/** "2026-11-19" + n dias. */
export function proximasDatas(hoje: string, dias: number): string[] {
  const base = Date.parse(`${hoje}T12:00:00Z`);
  return Array.from(
    { length: dias },
    (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10),
  );
}
