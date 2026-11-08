// Espelha o Minha Agenda no banco: serviços, horário e regras de agendamento.Chamada uma vez por dia pelo pg_cron (ver migration do espelho). Não exige JWT: só lê dados públicos e recusa rodar de novo em menos de 30 min.

import { clienteServico } from "../_shared/db.ts";
import type { SupabaseClient } from "../_shared/deps.ts";
import {
  enviarEmailResend,
  enviarResumo,
  lerConfigAviso,
} from "../_shared/aviso.ts";
import {
  lerPerfil,
  LeituraSuspeita,
  planejar,
  URL_PERFIL,
  type ServicoBanco,
} from "../_shared/minhaagenda.ts";

const INTERVALO_MINIMO_MS = 30 * 60 * 1000;

function log(evento: string, dados: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ evento, ...dados }));
}

function json(status: number, corpo: unknown) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function gravarInfo(db: SupabaseClient, chave: string, valor: string) {
  const { error } = await db
    .from("salao_info")
    .upsert({ chave, valor, atualizado_em: new Date().toISOString() });
  if (error) throw error;
}

export async function buscarPerfil(
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const resp = await fetchFn(URL_PERFIL, {
    headers: {
      accept: "application/json, text/plain, */*",
      check: "1", // o site manda este cabeçalho; mantido igual
      Referer: "https://online.maapp.com.br/",
    },
  });
  if (!resp.ok) throw new Error(`Minha Agenda respondeu HTTP ${resp.status}`);
  return await resp.json();
}

export async function tratar(req: Request): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET")
    return json(405, { erro: "método não permitido" });
  const db = clienteServico();
  const aviso = lerConfigAviso((n) => Deno.env.get(n));
  const depsAviso = { enviarEmail: enviarEmailResend, log };

  const { data: ultima } = await db
    .from("salao_info")
    .select("valor")
    .eq("chave", "sincronizado_em")
    .maybeSingle();
  if (
    ultima?.valor &&
    Date.now() - new Date(ultima.valor).getTime() < INTERVALO_MINIMO_MS
  ) {
    return json(429, { erro: "sincronização feita há menos de 30 min" });
  }
  await gravarInfo(db, "sincronizado_em", new Date().toISOString());

  try {
    const perfil = lerPerfil(await buscarPerfil());
    const { data: banco, error } = await db
      .from("salao_servicos")
      .select(
        "id, origem_id, nome, preco, duracao, categoria, a_partir_de, ativo, ordem",
      );
    if (error) throw error;
    const plano = planejar(banco as ServicoBanco[], perfil.servicos);
    const agora = new Date().toISOString();

    if (plano.apagarLegados.length) {
      const r = await db
        .from("salao_servicos")
        .delete()
        .in("id", plano.apagarLegados);
      if (r.error) throw r.error;
    }
    if (plano.inserir.length) {
      const r = await db.from("salao_servicos").insert(
        plano.inserir.map((s) => ({
          ...s,
          ativo: true,
          sincronizado_em: agora,
        })),
      );
      if (r.error) throw r.error;
    }
    for (const u of plano.atualizar) {
      const r = await db
        .from("salao_servicos")
        .update({ ...u.dados, sincronizado_em: agora, atualizado_em: agora })
        .eq("id", u.id);
      if (r.error) throw r.error;
    }
    if (plano.desativar.length) {
      const r = await db
        .from("salao_servicos")
        .update({ ativo: false, sincronizado_em: agora })
        .in("id", plano.desativar);
      if (r.error) throw r.error;
    }

    const mudancasInfo: string[] = [];
    for (const [chave, novo, rotulo] of [
      ["horario_funcionamento", perfil.horario, "Horário"],
      ["regras_agendamento", perfil.regras, "Regras de agendamento"],
    ] as const) {
      if (!novo) continue;
      const { data: atual } = await db
        .from("salao_info")
        .select("valor")
        .eq("chave", chave)
        .maybeSingle();
      if (atual?.valor !== novo) {
        await gravarInfo(db, chave, novo);
        mudancasInfo.push(`${rotulo}: ${novo}`);
      }
    }

    const resumo = {
      servicos: perfil.servicos.length,
      inseridos: plano.inserir.length,
      atualizados: plano.atualizar.length,
      desativados: plano.desativar.length,
      legados_apagados: plano.apagarLegados.length,
      info_alterada: mudancasInfo.length,
    };
    await gravarInfo(
      db,
      "ultima_sincronizacao",
      JSON.stringify({ ok: true, em: agora, ...resumo }),
    );
    log("sincronizado", resumo);

    const linhas = [...plano.mudancas, ...mudancasInfo];
    if (linhas.length) {
      await enviarResumo(
        aviso,
        depsAviso,
        "IA do salão: mudanças vindas do Minha Agenda",
        `A sincronização diária com o Minha Agenda aplicou estas mudanças na IA:\n\n- ${linhas.join("\n- ")}\n`,
      );
    }
    return json(200, { ok: true, ...resumo });
  } catch (e) {
    const suspeita = e instanceof LeituraSuspeita;
    const motivo = e instanceof Error ? e.message : String(e);
    await gravarInfo(
      db,
      "ultima_sincronizacao",
      JSON.stringify({ ok: false, em: new Date().toISOString(), motivo }),
    );
    log("sincronizacao_falhou", { motivo, suspeita });
    await enviarResumo(
      aviso,
      depsAviso,
      "IA do salão: a sincronização com o Minha Agenda falhou",
      `Nada foi alterado nos serviços da IA.\n\nMotivo: ${motivo}\n`,
    );
    return json(suspeita ? 422 : 502, { ok: false, erro: motivo });
  }
}
