// Consulta de horários livres no Minha Agenda (somente leitura).
//
// Fluxo, igual ao da página de agendamento:
//  1. login anônimo no Firebase do Minha Agenda (chave pública do site);
//  2. cadastro de convidada com uma identidade FIXA (a própria Bruna), uma vez;
//  3. GET availableEmployeesByService -> quem faz o serviço na data;
//  4. GET availableTimes por profissional -> horários livres.
// O bot nunca usa nome/telefone de cliente aqui e nunca agenda nada.

const API = "https://apionline.maapp.com.br";
export const SLUG = "Brunaframeschihair";
// Identidade fixa da consulta, pedida pelo Victor em 2026-11-07.
export const IDENTIDADE = {
  name: "Bruna Frameschi",
  phone: "11988973181",
  countryIso: "BR",
};

export interface Sessao {
  idToken: string;
  refreshToken: string;
  expiraEm: number; // epoch ms
  cadastrado: boolean; // já fez o firebaseGuestSignUp com este usuário anônimo
}

export interface ArmazemSessao {
  ler(): Promise<Sessao | null>;
  gravar(s: Sessao | null): Promise<void>;
}

export interface Profissional {
  id: number;
  nome: string;
}
export interface Vaga {
  inicio: string;
  fim: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export class FalhaConsulta extends Error {}

const cabecalhosApi = (token?: string): Record<string, string> => ({
  accept: "application/json, text/plain, */*",
  check: "1",
  Referer: "https://online.maapp.com.br/",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

// ---------- leitura das respostas (puras, testadas) ----------

export function lerProfissionais(json: unknown): Profissional[] {
  const out: Profissional[] = [];
  for (const bloco of arr(json)) {
    for (const p of arr(obj(bloco).listEmployeeInfo)) {
      const e = obj(p);
      if (
        typeof e.id === "number" &&
        typeof e.name === "string" &&
        !out.some((x) => x.id === e.id)
      ) {
        out.push({ id: e.id, nome: e.name.trim().replace(/\s+/g, " ") });
      }
    }
  }
  return out;
}

export function lerVagas(json: unknown): { vagas: Vaga[]; feriado: boolean } {
  const raiz = obj(json);
  const vagas = arr(raiz.listAppointmentAvailabilityDTO).flatMap((v) => {
    const x = obj(v);
    return typeof x.startTime === "string" && typeof x.endTime === "string"
      ? [{ inicio: x.startTime, fim: x.endTime }]
      : [];
  });
  return { vagas, feriado: raiz.holiday === true };
}

/** "Bruna Stefani frameschi" -> "Bruna": é como as clientes chamam. */
export function primeiroNome(nome: string): string {
  const p = nome.trim().split(/\s+/)[0] ?? "";
  return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : nome;
}

/** Hoje em São Paulo, AAAA-MM-DD. */
export function hojeSaoPaulo(agora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(agora);
}

/** Valida a data pedida: AAAA-MM-DD, de hoje até `maxDias` à frente. */
export function validarData(
  data: string,
  maxDias: number,
  agora = new Date(),
): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(data) ||
    Number.isNaN(Date.parse(`${data}T12:00:00Z`))
  ) {
    return "data inválida: use o formato AAAA-MM-DD";
  }
  const hoje = Date.parse(`${hojeSaoPaulo(agora)}T12:00:00Z`);
  const dias = Math.round(
    (Date.parse(`${data}T12:00:00Z`) - hoje) / 86_400_000,
  );
  if (dias < 0) return "essa data já passou";
  if (dias > maxDias)
    return `o agendamento online só abre até ${maxDias} dias à frente`;
  return null;
}

// ---------- login e cadastro (também usados no agendamento) ----------

export async function loginAnonimo(
  firebaseKey: string,
  fetchFn: typeof fetch = fetch,
  agora: () => number = () => Date.now(),
): Promise<Sessao> {
  const r = await fetchFn(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );
  const j = obj(await r.json().catch(() => ({})));
  if (
    !r.ok ||
    typeof j.idToken !== "string" ||
    typeof j.refreshToken !== "string"
  ) {
    throw new FalhaConsulta(`login anônimo falhou (HTTP ${r.status})`);
  }
  return {
    idToken: j.idToken,
    refreshToken: j.refreshToken,
    expiraEm: agora() + Number(j.expiresIn ?? 3600) * 1000,
    cadastrado: false,
  };
}

export interface Identidade {
  name: string;
  phone: string;
  countryIso: string;
}

export async function cadastrarConvidada(
  idToken: string,
  identidade: Identidade,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const r = await fetchFn(`${API}/accounts/firebaseGuestSignUp`, {
    method: "POST",
    headers: { ...cabecalhosApi(), "content-type": "application/json" },
    body: JSON.stringify({
      ...identidade,
      email: null,
      accessToken: idToken,
      slug: SLUG,
    }),
  });
  await r.body?.cancel();
  if (!r.ok)
    throw new FalhaConsulta(`cadastro de convidada falhou (HTTP ${r.status})`);
}

export { API, cabecalhosApi };

// ---------- cliente de consulta ----------

export class ConsultaMinhaAgenda {
  private cache = new Map<string, { em: number; valor: Agenda }>();

  constructor(
    private firebaseKey: string,
    private armazem: ArmazemSessao,
    private fetchFn: typeof fetch = fetch,
    private agora: () => number = () => Date.now(),
  ) {}

  private loginAnonimo(): Promise<Sessao> {
    return loginAnonimo(this.firebaseKey, this.fetchFn, this.agora);
  }

  private async renovar(s: Sessao): Promise<Sessao | null> {
    const r = await this.fetchFn(
      `https://securetoken.googleapis.com/v1/token?key=${this.firebaseKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: s.refreshToken,
        }).toString(),
      },
    );
    const j = obj(await r.json().catch(() => ({})));
    if (!r.ok || typeof j.id_token !== "string") return null;
    return {
      ...s,
      idToken: j.id_token,
      refreshToken:
        typeof j.refresh_token === "string" ? j.refresh_token : s.refreshToken,
      expiraEm: this.agora() + Number(j.expires_in ?? 3600) * 1000,
    };
  }

  private async cadastrarConvidada(s: Sessao): Promise<Sessao> {
    await cadastrarConvidada(s.idToken, IDENTIDADE, this.fetchFn);
    return { ...s, cadastrado: true };
  }

  /** Token válido: reaproveita, renova ou faz login novo. */
  async token(forcarNovo = false): Promise<string> {
    let s = forcarNovo ? null : await this.armazem.ler();
    if (s && s.expiraEm - this.agora() < 60_000) s = await this.renovar(s);
    if (!s) s = await this.loginAnonimo();
    if (!s.cadastrado) s = await this.cadastrarConvidada(s);
    await this.armazem.gravar(s);
    return s.idToken;
  }

  private async getApi(caminho: string): Promise<unknown> {
    for (const novo of [false, true]) {
      const r = await this.fetchFn(
        `${API}/companyProfiles/${SLUG}/${caminho}`,
        { headers: cabecalhosApi(await this.token(novo)) },
      );
      if (r.status === 401 || r.status === 403) {
        await r.body?.cancel();
        continue;
      } // sessão recusada: tenta 1x com login novo
      if (!r.ok) {
        await r.body?.cancel();
        throw new FalhaConsulta(`Minha Agenda respondeu HTTP ${r.status}`);
      }
      return await r.json();
    }
    throw new FalhaConsulta("Minha Agenda recusou a sessão");
  }

  /** Vagas por profissional. Cache de 5 min por serviço+data, a menos que `semCache`. */
  async vagas(
    servicoId: number,
    data: string,
    semCache = false,
  ): Promise<Agenda> {
    const chave = `${servicoId}|${data}`;
    const c = this.cache.get(chave);
    if (!semCache && c && this.agora() - c.em < 5 * 60_000) return c.valor;

    const profissionais = lerProfissionais(
      await this.getApi(
        `availableEmployeesByService?serviceIds=${servicoId}&date=${data}`,
      ),
    );
    const agenda: Agenda = { data, feriado: false, profissionais: [] };
    for (const p of profissionais) {
      const { vagas, feriado } = lerVagas(
        await this.getApi(
          `availableTimes?serviceIds=${servicoId}&employeeId=${p.id}&date=${data}`,
        ),
      );
      if (feriado) {
        agenda.feriado = true;
        agenda.profissionais = [];
        break;
      }
      agenda.profissionais.push({
        id: p.id,
        nome: primeiroNome(p.nome),
        horarios: vagas.map((v) => v.inicio),
      });
    }
    this.cache.set(chave, { em: this.agora(), valor: agenda });
    return agenda;
  }

  /** Horários livres em texto para o modelo. */
  async horarios(servicoId: number, data: string): Promise<string> {
    return agendaEmTexto(await this.vagas(servicoId, data));
  }
}

export interface Agenda {
  data: string;
  feriado: boolean;
  profissionais: Array<{ id: number; nome: string; horarios: string[] }>;
}

export function agendaEmTexto(a: Agenda): string {
  if (a.feriado) return `${a.data} é feriado: não há atendimento.`;
  if (a.profissionais.length === 0)
    return `Em ${a.data} ninguém atende esse serviço pelo agendamento online.`;
  const linhas = a.profissionais.map(
    (p) =>
      `${p.nome}: ${p.horarios.length ? p.horarios.join(", ") : "sem horários livres"}`,
  );
  return `Horários livres em ${a.data} (consulta feita agora; podem ser ocupados a qualquer momento):\n${linhas.join("\n")}`;
}
