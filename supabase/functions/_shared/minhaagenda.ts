// Espelho do Minha Agenda: lê o JSON público do perfil da Bruna e calcula o
// que mudar no banco. Sem rede nem banco aqui: tudo testável.
// O Minha Agenda é a fonte da verdade (nomes, preços, durações, horário e
// regras de agendamento). O bot só espelha.

export const URL_PERFIL =
  "https://apionline.maapp.com.br/companyProfiles/Brunaframeschihair";

// ---------- formato da API (só o que usamos) ----------

export interface ServicoApi {
  id: number;
  name: string;
  price: number | null;
  duration: number | null; // minutos
  serviceCategory: { name: string } | null;
  onlineSchedulingPriceDisplay: string | null; // "FIXED" | "STARTS_AT" | ...
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

// ---------- formatação ----------

export function formatarPreco(
  valor: number | null,
  aPartirDe: boolean,
): string {
  if (valor == null || !Number.isFinite(valor)) return "consultar";
  const brl = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  })
    .format(valor)
    .replace(/ /g, " ");
  return aPartirDe ? `a partir de ${brl}` : brl;
}

export function formatarDuracao(minutos: number | null): string | null {
  if (minutos == null || !Number.isFinite(minutos) || minutos <= 0) return null;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function hora(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

const DIAS: Array<[string, string]> = [
  ["mon", "segunda"],
  ["tue", "terça"],
  ["wed", "quarta"],
  ["thu", "quinta"],
  ["fri", "sexta"],
  ["sat", "sábado"],
  ["sun", "domingo"],
];

/** Ex.: "terça a sábado, das 8h às 12h e das 13h às 19h. Fechado: segunda e domingo." */
export function horarioDeTrabalho(ws: unknown): string | null {
  const w = obj(ws);
  const porDia = DIAS.map(([k, nome]) => {
    if (w[`${k}Enabled`] !== true)
      return { nome, texto: null as string | null };
    const faixas: string[] = [];
    for (const i of [1, 2, 3]) {
      const ini = w[`${k}StartTime${i}`],
        fim = w[`${k}EndTime${i}`];
      if (typeof ini === "string" && typeof fim === "string")
        faixas.push(`das ${hora(ini)} às ${hora(fim)}`);
    }
    return { nome, texto: faixas.length ? faixas.join(" e ") : null };
  });
  if (!porDia.some((d) => d.texto)) return null;

  // Agrupa dias seguidos com o mesmo horário.
  const grupos: Array<{ dias: string[]; texto: string }> = [];
  for (const d of porDia) {
    const ultimo = grupos[grupos.length - 1];
    if (
      d.texto &&
      ultimo &&
      ultimo.texto === d.texto &&
      porDia[porDia.indexOf(d) - 1]?.texto === d.texto
    ) {
      ultimo.dias.push(d.nome);
    } else if (d.texto) {
      grupos.push({ dias: [d.nome], texto: d.texto });
    }
  }
  const abertos = grupos
    .map(
      (g) =>
        `${g.dias.length > 1 ? `${g.dias[0]} a ${g.dias[g.dias.length - 1]}` : g.dias[0]}, ${g.texto}`,
    )
    .join("; ");
  const fechados = porDia.filter((d) => !d.texto).map((d) => d.nome);
  return fechados.length
    ? `${abertos}. Fechado: ${fechados.join(" e ").replace(/ e (?=.* e )/g, ", ")}.`
    : `${abertos}.`;
}

/** Antecedência, cancelamento e avisos do agendamento online, em texto para o bot. */
export function regrasDeAgendamento(info: unknown): string | null {
  const c = obj(info);
  const partes: string[] = [];
  const min =
    typeof c.minAmountOfMinutesBeforeSchedule === "number"
      ? c.minAmountOfMinutesBeforeSchedule
      : null;
  const max =
    typeof c.maxAmountOfDaysAfterSchedule === "number"
      ? c.maxAmountOfDaysAfterSchedule
      : null;
  if (min)
    partes.push(
      `O agendamento online precisa ser feito com pelo menos ${formatarDuracao(min)} de antecedência.`,
    );
  if (max) partes.push(`Dá para agendar online até ${max} dias à frente.`);
  if (
    typeof c.cancelingPolicyText === "string" &&
    c.cancelingPolicyText.trim()
  ) {
    partes.push(`Política de cancelamento: ${c.cancelingPolicyText.trim()}`);
  }
  if (
    typeof c.appointmentWarningMessage === "string" &&
    c.appointmentWarningMessage.trim()
  ) {
    partes.push(
      `Aviso do salão para agendamentos: ${c.appointmentWarningMessage.trim().replace(/\s*\n+\s*/g, " ")}`,
    );
  }
  return partes.length ? partes.join("\n") : null;
}

// ---------- leitura do JSON ----------

export interface ServicoEspelho {
  origem_id: number;
  nome: string;
  preco: string;
  duracao: string | null;
  categoria: string | null;
  a_partir_de: boolean;
  ordem: number;
}

export interface PerfilLido {
  servicos: ServicoEspelho[];
  horario: string | null;
  regras: string | null;
}

export function lerPerfil(json: unknown): PerfilLido {
  const raiz = obj(json);
  const lista = Array.isArray(raiz.services) ? raiz.services : [];
  const servicos: ServicoEspelho[] = [];
  for (const item of lista) {
    const s = obj(item);
    const id = typeof s.id === "number" ? s.id : null;
    const nome = typeof s.name === "string" ? s.name.trim() : "";
    if (!id || !nome) continue;
    // Espelho fiel: "a partir de" só quando o próprio Minha Agenda marca assim.
    const aPartirDe = s.onlineSchedulingPriceDisplay === "STARTS_AT";
    servicos.push({
      origem_id: id,
      nome,
      preco: formatarPreco(
        typeof s.price === "number" ? s.price : null,
        aPartirDe,
      ),
      duracao: formatarDuracao(
        typeof s.duration === "number" ? s.duration : null,
      ),
      categoria:
        typeof obj(s.serviceCategory).name === "string"
          ? (obj(s.serviceCategory).name as string)
          : null,
      a_partir_de: aPartirDe,
      ordem: servicos.length + 1,
    });
  }
  return {
    servicos,
    horario: horarioDeTrabalho(raiz.workSchedule),
    regras: regrasDeAgendamento(raiz.companyInfo),
  };
}

// ---------- comparação (de-para) ----------

export interface ServicoBanco {
  id: string;
  origem_id: number | null;
  nome: string;
  preco: string;
  duracao: string | null;
  categoria: string | null;
  a_partir_de: boolean;
  ativo: boolean;
  ordem: number;
}

export interface Plano {
  inserir: ServicoEspelho[];
  atualizar: Array<{ id: string; dados: ServicoEspelho & { ativo: true } }>;
  desativar: string[]; // ids do banco: sumiram do Minha Agenda
  apagarLegados: string[]; // ids do banco sem origem_id (cadastro manual antigo)
  mudancas: string[]; // texto para o e-mail de resumo
}

export class LeituraSuspeita extends Error {}

/**
 * Calcula o que mudar. Lança LeituraSuspeita se a resposta parecer quebrada
 * (vazia ou com menos da metade dos serviços já espelhados): nesse caso nada muda.
 */
export function planejar(banco: ServicoBanco[], site: ServicoEspelho[]): Plano {
  const jaEspelhados = banco.filter(
    (b) => b.origem_id != null && b.ativo,
  ).length;
  if (site.length === 0)
    throw new LeituraSuspeita("o Minha Agenda não devolveu nenhum serviço");
  if (jaEspelhados > 0 && site.length < jaEspelhados / 2) {
    throw new LeituraSuspeita(
      `o Minha Agenda devolveu ${site.length} serviços, eram ${jaEspelhados}`,
    );
  }

  const porOrigem = new Map(
    banco.filter((b) => b.origem_id != null).map((b) => [b.origem_id!, b]),
  );
  const plano: Plano = {
    inserir: [],
    atualizar: [],
    desativar: [],
    apagarLegados: [],
    mudancas: [],
  };

  for (const s of site) {
    const atual = porOrigem.get(s.origem_id);
    if (!atual) {
      plano.inserir.push(s);
      plano.mudancas.push(
        `Novo: ${s.nome} (${s.preco}${s.duracao ? `, ${s.duracao}` : ""})`,
      );
      continue;
    }
    const diffs: string[] = [];
    if (atual.nome !== s.nome) diffs.push(`nome "${atual.nome}" → "${s.nome}"`);
    if (atual.preco !== s.preco)
      diffs.push(`preço ${atual.preco} → ${s.preco}`);
    if (atual.duracao !== s.duracao)
      diffs.push(`duração ${atual.duracao ?? "-"} → ${s.duracao ?? "-"}`);
    if (!atual.ativo) diffs.push("voltou para o Minha Agenda");
    if (diffs.length) plano.mudancas.push(`${s.nome}: ${diffs.join("; ")}`);
    if (
      diffs.length ||
      atual.categoria !== s.categoria ||
      atual.a_partir_de !== s.a_partir_de ||
      atual.ordem !== s.ordem
    ) {
      plano.atualizar.push({ id: atual.id, dados: { ...s, ativo: true } });
    }
  }

  const noSite = new Set(site.map((s) => s.origem_id));
  for (const b of banco) {
    if (b.origem_id == null) {
      plano.apagarLegados.push(b.id);
    } else if (b.ativo && !noSite.has(b.origem_id)) {
      plano.desativar.push(b.id);
      plano.mudancas.push(`Saiu do Minha Agenda: ${b.nome}`);
    }
  }
  if (plano.apagarLegados.length) {
    plano.mudancas.push(
      `${plano.apagarLegados.length} serviço(s) cadastrados à mão foram substituídos pelo espelho do Minha Agenda`,
    );
  }
  return plano;
}
