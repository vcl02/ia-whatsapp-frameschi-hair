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
    carregarLista();
    timer = setInterval(() => {
      carregarLista();
      carregarMsgs();
    }, 15000);
  }
});
