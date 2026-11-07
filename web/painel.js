// Lógica da tela de conversas. Carregado por index.html.
const sb = supabase.createClient(
  window.PAINEL.supabaseUrl,
  window.PAINEL.supabaseAnonKey,
);

const $ = (id) => document.getElementById(id);
let atual = null;

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs))
    k === "class" ? (e.className = v) : e.setAttribute(k, v);
  for (const f of filhos) if (f != null) e.append(f); // append de string = texto, sem HTML
  return e;
}
const hora = (s) =>
  s
    ? new Date(s).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";

async function carregarLista() {
  const { data, error } = await sb
    .from("salao_conversas")
    .select(
      "id, wa_id, nome_perfil, bot_pausado, precisa_humano, motivo_humano, atualizado_em",
    )
    .order("precisa_humano", { ascending: false })
    .order("atualizado_em", { ascending: false })
    .limit(200);
  if (error) return alert(error.message);
  $("lista").replaceChildren(
    ...data.map((c) => {
      const i = el(
        "div",
        { class: "item" + (atual?.id === c.id ? " ativo" : "") },
        c.nome_perfil || c.wa_id,
        c.precisa_humano
          ? el("span", { class: "tag alerta" }, "precisa de você")
          : null,
        c.bot_pausado && !c.precisa_humano
          ? el("span", { class: "tag" }, "bot pausado")
          : null,
        el("small", {}, hora(c.atualizado_em)),
      );
      i.onclick = () => abrir(c);
      return i;
    }),
  );
  if (atual) {
    const novo = data.find((c) => c.id === atual.id);
    if (novo) {
      atual = novo;
      desenharTopo();
    }
  }
}

function desenharTopo() {
  const c = atual;
  const pausa = el("button", {}, c.bot_pausado ? "Retomar bot" : "Pausar bot");
  pausa.onclick = async () => {
    const mudanca = c.bot_pausado
      ? { bot_pausado: false, precisa_humano: false, motivo_humano: null }
      : { bot_pausado: true };
    const { error } = await sb
      .from("salao_conversas")
      .update(mudanca)
      .eq("id", c.id);
    if (error) return alert(error.message);
    await carregarLista();
  };
  $("topo").replaceChildren(
    el("strong", {}, `${c.nome_perfil || ""} ${c.wa_id}`),
    c.precisa_humano
      ? el("span", { class: "alerta" }, c.motivo_humano || "precisa de humano")
      : null,
    pausa,
  );
}

async function abrir(c) {
  atual = c;
  $("falhas").classList.add("oculto");
  $("servicos").classList.add("oculto");
  $("msgs").classList.remove("oculto");
  $("envio").classList.remove("oculto");
  desenharTopo();
  await carregarMsgs();
  await carregarLista();
}

async function carregarMsgs() {
  if (!atual) return;
  const { data, error } = await sb
    .from("salao_mensagens")
    .select("autor, tipo, texto, status, erro, criado_em")
    .eq("conversa_id", atual.id)
    .order("criado_em")
    .limit(500);
  if (error) return alert(error.message);
  const caixa = $("msgs");
  const noFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 40;
  caixa.replaceChildren(
    ...data.map((m) =>
      el(
        "div",
        { class: "msg " + m.autor },
        m.texto ?? `[${m.tipo}]`,
        el(
          "small",
          { class: m.erro ? "alerta" : "" },
          `${m.autor} · ${hora(m.criado_em)}${m.status ? " · " + m.status : ""}${m.erro ? " · erro: " + JSON.stringify(m.erro) : ""}`,
        ),
      ),
    ),
  );
  if (noFim) caixa.scrollTop = caixa.scrollHeight;
}

let enviando = false; // evita mandar a mesma mensagem várias vezes por clique repetido
$("envio").onsubmit = async (e) => {
  e.preventDefault();
  const texto = $("texto").value.trim();
  if (!texto || !atual || enviando) return;
  enviando = true;
  const botao = $("envio").querySelector("button");
  botao.disabled = true;
  botao.textContent = "Enviando…";
  try {
    const { error } = await sb.functions.invoke("salao-responder", {
      body: { conversa_id: atual.id, texto },
    });
    if (error) {
      let msg = error.message;
      try {
        msg = (await error.context.json()).erro || msg;
      } catch {}
      return alert(msg);
    }
    $("texto").value = "";
    await carregarMsgs();
    await carregarLista();
  } finally {
    enviando = false;
    botao.disabled = false;
    botao.textContent = "Enviar";
  }
};

$("btnFalhas").onclick = async () => {
  atual = null;
  $("msgs").classList.add("oculto");
  $("envio").classList.add("oculto");
  $("servicos").classList.add("oculto");
  $("falhas").classList.remove("oculto");
  $("topo").replaceChildren(
    el("strong", {}, "Falhas de envio (statuses com erro)"),
  );
  const { data, error } = await sb
    .from("salao_falhas_de_envio")
    .select("*")
    .limit(200);
  if (error) return alert(error.message);
  const cols = [
    "recebido_em",
    "tipo_mensagem",
    "codigo",
    "titulo",
    "mensagem",
    "detalhes",
    "recipient_id",
  ];
  $("falhas").replaceChildren(
    data.length === 0
      ? "Nenhuma falha registrada."
      : el(
          "table",
          {},
          el("tr", {}, ...cols.map((c) => el("th", {}, c))),
          ...data.map((r) =>
            el(
              "tr",
              {},
              ...cols.map((c) =>
                el(
                  "td",
                  {},
                  c === "recebido_em" ? hora(r[c]) : String(r[c] ?? ""),
                ),
              ),
            ),
          ),
        ),
  );
};

// Serviços: espelho do Minha Agenda (só leitura). Para mudar, altere no Minha Agenda; a sincronização diária traz a mudança para cá.
function textoSincronizacao(info) {
  try {
    const u = JSON.parse(info.ultima_sincronizacao || "null");
    if (!u) return "Ainda não sincronizado com o Minha Agenda.";
    const quando = hora(u.em);
    return u.ok
      ? `Espelho do Minha Agenda · última sincronização: ${quando}`
      : `A última sincronização falhou (${quando}): ${u.motivo}. Os dados abaixo são da sincronização anterior.`;
  } catch {
    return "";
  }
}

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
  $("btnFalhas").classList.toggle("oculto", !logado);
  clearInterval(timer);
  if (logado) {
    carregarLista();
    timer = setInterval(() => {
      carregarLista();
      carregarMsgs();
    }, 15000);
  }
});
