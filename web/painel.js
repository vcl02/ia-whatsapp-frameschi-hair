// Painel da IA: página inicial com o liga/desliga da IA e o que importa (números,
// conversas que precisam de atenção, erros e agendamentos).
// Não exibe o conteúdo das conversas (privacidade); o banco também não deixa a equipe ler.
const sb = supabase.createClient(
  window.PAINEL.supabaseUrl,
  window.PAINEL.supabaseAnonKey,
);

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs))
    k === "class" ? (e.className = v) : e.setAttribute(k, v);
  for (const f of filhos) if (f != null) e.append(f); // append de string = texto, sem HTML
  return e;
}

const quando = (s) =>
  s
    ? new Date(s).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

function diaDaSemana(data) {
  // data = AAAA-MM-DD; meio-dia UTC evita virar o dia por fuso.
  const d = new Date(`${data}T12:00:00Z`);
  const sem = d.toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" });
  const dm = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  return `${sem.replace(".", "")} ${dm}`;
}

function telefone(waId) {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(waId || "");
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${waId}`;
}

const vazio = (texto) => el("p", { class: "vazio" }, texto);
const falha = (e) => console.error(e);

// ---------- IA: liga/desliga ----------
let iaAtiva = null;

function desenharIA(ctrl) {
  iaAtiva = ctrl.ia_ativa;
  const hero = $("hero");
  hero.classList.toggle("ligada", iaAtiva);
  hero.classList.toggle("desligada", !iaAtiva);
  $("iaEstado").textContent = iaAtiva
    ? "Respondendo as clientes no WhatsApp."
    : "Nenhuma resposta automática está sendo enviada.";
  $("iaMeta").textContent = ctrl.atualizado_em ? `Última mudança: ${quando(ctrl.atualizado_em)}` : "";
  const chave = $("iaChave");
  chave.classList.toggle("ligada", iaAtiva);
  chave.classList.toggle("desligada", !iaAtiva);
  chave.setAttribute("aria-pressed", String(iaAtiva));
  chave.replaceChildren(
    el("span", {}, iaAtiva ? "IA ligada" : "IA desligada", el("small", {}, iaAtiva ? "Clique para desligar" : "Clique para ligar")),
  );
  chave.disabled = false;
}

$("iaChave").onclick = async () => {
  if (iaAtiva === null) return;
  const novo = !iaAtiva;
  if (!novo && !confirm("Desligar a IA? Nenhuma cliente receberá resposta automática até você ligar de novo.")) return;
  const chave = $("iaChave");
  chave.disabled = true;
  const { error } = await sb.from("salao_controle").update({ ia_ativa: novo }).eq("id", 1);
  if (error) {
    alert("Não consegui mudar: " + error.message);
    chave.disabled = false;
    return;
  }
  await carregar();
};

async function carregarIA() {
  const { data, error } = await sb.from("salao_controle").select("ia_ativa, atualizado_em").eq("id", 1).maybeSingle();
  if (error || !data) {
    $("iaEstado").textContent = "Não consegui ler o estado da IA. Confira se a migration do painel foi aplicada.";
    falha(error);
    return;
  }
  desenharIA(data);
}

// ---------- números ----------
async function carregarNumeros() {
  const { data, error } = await sb.rpc("salao_painel_resumo");
  if (error || !data) return falha(error);
  const itens = [
    ["Conversas hoje", data.conversas_hoje, ""],
    ["Respostas da IA hoje", data.respostas_hoje, ""],
    ["Agendamentos hoje", data.agendamentos_hoje, ""],
    ["Precisam de você", data.precisam_atencao, data.precisam_atencao > 0 ? "alerta" : ""],
  ];
  if (data.falhas_24h > 0) itens.push(["Erros nas últimas 24 h", data.falhas_24h, "erro"]);
  $("numeros").classList.toggle("cinco", itens.length > 4);
  $("numeros").replaceChildren(
    ...itens.map(([rotulo, valor, tipo]) =>
      el("div", { class: `card numero ${tipo}` }, el("div", { class: "valor" }, String(valor)), el("div", { class: "rotulo" }, rotulo)),
    ),
  );
}

// ---------- conversas que precisam de atenção ----------
async function retomar(id) {
  const { error } = await sb
    .from("salao_conversas")
    .update({ bot_pausado: false, precisa_humano: false, motivo_humano: null })
    .eq("id", id);
  if (error) return alert("Não consegui retomar: " + error.message);
  await carregar();
}

async function carregarAtencao() {
  const { data, error } = await sb
    .from("salao_conversas")
    .select("id, wa_id, nome_perfil, bot_pausado, precisa_humano, atualizado_em")
    .or("precisa_humano.eq.true,bot_pausado.eq.true")
    .order("precisa_humano", { ascending: false })
    .order("atualizado_em", { ascending: false })
    .limit(30);
  if (error) return falha(error);
  $("atencaoN").textContent = data.length ? String(data.length) : "";
  $("atencao").replaceChildren(
    ...(data.length
      ? data.map((c) => {
          const botao = el("button", { class: "btn pequeno" }, "Retomar IA");
          botao.onclick = () => retomar(c.id);
          return el(
            "div",
            { class: "linha" },
            el(
              "div",
              { class: "principal" },
              el("div", { class: "titulo" }, c.nome_perfil || telefone(c.wa_id)),
              el("div", { class: "sub" }, `${c.nome_perfil ? telefone(c.wa_id) + " · " : ""}${quando(c.atualizado_em)}`),
            ),
            el("span", { class: c.precisa_humano ? "selo warn" : "selo gold" }, c.precisa_humano ? "Precisa de você" : "IA pausada"),
            botao,
          );
        })
      : [vazio("Nenhuma conversa esperando por você.")]),
  );
}

// ---------- erros ----------
function detalheDoEvento(bruto) {
  if (!bruto) return "";
  try {
    const d = JSON.parse(bruto);
    const t = d.erro ?? d.erros;
    return String(typeof t === "string" ? t : JSON.stringify(t ?? d)).slice(0, 140);
  } catch {
    return String(bruto).slice(0, 140);
  }
}

const ROTULO_EVENTO = {
  erro_llm: "Falha ao gerar a resposta da IA",
  erro_agendamento: "Falha ao agendar no Minha Agenda",
  erro_consulta_horarios: "Falha ao consultar horários",
  erro_aviso: "Falha ao enviar o e-mail de aviso",
  erro_aviso_agendamento: "Falha ao enviar o e-mail de agendamento",
  erro_segundo_plano: "Erro interno ao processar a mensagem",
  status_falha: "Mensagem não entregue no WhatsApp",
};
async function carregarErros() {
  const [falhas, info] = await Promise.all([
    sb.from("salao_falhas_de_envio").select("recebido_em, codigo, titulo, mensagem").limit(8),
    sb.from("salao_info").select("valor").eq("chave", "ultima_sincronizacao").maybeSingle(),
  ]);
  const linhas = [];
  try {
    const s = JSON.parse(info.data?.valor || "null");
    if (s && s.ok === false)
      linhas.push(["Sincronização com o Minha Agenda falhou", String(s.motivo || ""), s.em]);
  } catch {
    /* sem dado de sincronização */
  }
  for (const f of falhas.data || [])
    linhas.push([f.titulo || "Falha ao entregar mensagem", [f.codigo, f.mensagem].filter(Boolean).join(" · "), f.recebido_em]);
  const { data: eventos } = await sb
    .from("salao_eventos")
    .select("tipo, detalhe, criado_em")
    .order("criado_em", { ascending: false })
    .limit(8);
  for (const ev of eventos || []) linhas.push([ROTULO_EVENTO[ev.tipo] || "Erro interno", detalheDoEvento(ev.detalhe), ev.criado_em]);
  const { data: ag } = await sb
    .from("salao_agendamentos")
    .select("servico_nome, detalhe, atualizado_em")
    .eq("status", "falhou")
    .order("atualizado_em", { ascending: false })
    .limit(5);
  for (const a of ag || []) linhas.push([`Agendamento falhou: ${a.servico_nome}`, (a.detalhe || "").slice(0, 140), a.atualizado_em]);
  linhas.sort((a, b) => new Date(b[2]) - new Date(a[2]));
  $("errosN").textContent = linhas.length ? String(linhas.length) : "";
  $("erros").replaceChildren(
    ...(linhas.length
      ? linhas.slice(0, 10).map(([titulo, detalhe, quandoEm]) =>
          el(
            "div",
            { class: "linha" },
            el("div", { class: "principal" }, el("div", { class: "titulo" }, titulo), detalhe ? el("div", { class: "sub" }, detalhe) : null),
            el("span", { class: "quando" }, quando(quandoEm)),
          ),
        )
      : [vazio("Nenhum erro registrado. Tudo certo por aqui.")]),
  );
}

// ---------- agendamentos ----------
async function carregarAgendamentos() {
  const { data, error } = await sb
    .from("salao_agendamentos")
    .select("servico_nome, profissional_nome, data, hora, nome_cliente, status")
    .in("status", ["agendado", "falhou"])
    .order("data", { ascending: false })
    .order("hora", { ascending: false })
    .limit(15);
  if (error) return falha(error);
  $("agendamentos").replaceChildren(
    ...(data.length
      ? data.map((a) =>
          el(
            "div",
            { class: "linha" },
            el(
              "div",
              { class: "principal" },
              el("div", { class: "titulo" }, a.servico_nome),
              el("div", { class: "sub" }, `${diaDaSemana(a.data)} às ${a.hora} · ${a.profissional_nome} · ${a.nome_cliente}`),
            ),
            el("span", { class: a.status === "agendado" ? "selo ok" : "selo bad" }, a.status === "agendado" ? "Agendado" : "Falhou"),
          ),
        )
      : [vazio("A IA ainda não fez nenhum agendamento.")]),
  );
}

async function carregar() {
  await Promise.allSettled([carregarIA(), carregarNumeros(), carregarAtencao(), carregarErros(), carregarAgendamentos()]);
}

// ---------- sessão ----------
$("login").onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({
    email: $("email").value,
    password: $("senha").value,
  });
  $("erroLogin").textContent = error ? error.message : "";
};
$("btnSair").onclick = () => sb.auth.signOut();

let timer = null;
sb.auth.onAuthStateChange((_ev, sessao) => {
  const logado = !!sessao;
  $("login").classList.toggle("oculto", logado);
  $("app").classList.toggle("oculto", !logado);
  $("btnSair").classList.toggle("oculto", !logado);
  clearInterval(timer);
  if (logado) {
    carregar();
    timer = setInterval(carregar, 30000);
  }
});
