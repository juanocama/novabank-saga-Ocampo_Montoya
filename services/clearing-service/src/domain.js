import { pasarelaDb, exigirRespuesta } from "./supabase.js";

const DELAY_MS = Number(process.env.DELAY_MS || 3000);
const delay = () => new Promise((r) => setTimeout(r, DELAY_MS));

async function yaProcesado(idempotencyKey) {
  const { data, error } = await pasarelaDb
    .from("liquidaciones")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`consultar liquidación: ${error.message}`);
  return data;
}

export async function liquidar({ sagaId, idempotencyKey, monto, escenarioSimulado }) {
  await delay();

  const previo = await yaProcesado(idempotencyKey);
  if (previo) {
    return { estado: previo.estado === "LIQUIDADO" ? "EXITOSO" : "FALLIDO", datos: { duplicado: true } };
  }

  // El switch de "timeout de red" del frontend simula la caída de la pasarela externa (CP-04).
  const falla = escenarioSimulado === "FORZAR_TIMEOUT_RED";

  exigirRespuesta(await pasarelaDb.from("liquidaciones").insert({
    saga_id: sagaId,
    monto,
    estado: falla ? "FALLIDO" : "LIQUIDADO",
    idempotency_key: idempotencyKey,
  }), "guardar liquidación");

  return {
    estado: falla ? "FALLIDO" : "EXITOSO",
    datos: {},
    motivo: falla ? "CAIDA_RED_INTERBANCARIA" : null,
  };
}

export async function anularLiquidacion({ idempotencyKey }) {
  await delay();
  exigirRespuesta(await pasarelaDb.from("liquidaciones").update({ estado: "ANULADO" }).eq("idempotency_key", idempotencyKey), "anular liquidación");
  return { estado: "COMPENSADO", datos: {} };
}
