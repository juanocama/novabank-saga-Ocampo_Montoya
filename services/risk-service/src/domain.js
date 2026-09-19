import { riesgoDb, exigirRespuesta } from "./supabase.js";

const DELAY_MS = Number(process.env.DELAY_MS || 3000);
const delay = () => new Promise((r) => setTimeout(r, DELAY_MS));

const LIMITE_DIARIO = 50000; // regla simple de validación operativa

async function yaProcesado(idempotencyKey) {
  const { data, error } = await riesgoDb
    .from("evaluaciones")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`consultar evaluación: ${error.message}`);
  return data;
}

export async function evaluarRiesgo({ sagaId, idempotencyKey, cuentaOrigen, monto, escenarioSimulado }) {
  await delay();

  const previo = await yaProcesado(idempotencyKey);
  if (previo) {
    return { estado: previo.aprobado ? "EXITOSO" : "FALLIDO", datos: { duplicado: true } };
  }

  // El switch de simulación de fraude del frontend fuerza el rechazo aquí (CP-03).
  const forzado = escenarioSimulado === "FORZAR_RIESGO";
  const excedeLimite = Number(monto) > LIMITE_DIARIO;
  const aprobado = !forzado && !excedeLimite;

  exigirRespuesta(await riesgoDb.from("evaluaciones").insert({
    saga_id: sagaId,
    numero_cuenta: cuentaOrigen,
    monto,
    aprobado,
    motivo: forzado ? "Fraude simulado por el usuario" : excedeLimite ? "Excede límite diario" : null,
    idempotency_key: idempotencyKey,
  }), "guardar evaluación");

  return {
    estado: aprobado ? "EXITOSO" : "FALLIDO",
    datos: { aprobado },
    motivo: aprobado ? null : "RIESGO_RECHAZADO",
  };
}

// La aprobación de riesgo no mueve dinero, así que "compensar" es un registro
// de auditoría que anula la aprobación previa (útil para el caso CP-04).
export async function anularAprobacion({ sagaId, idempotencyKey }) {
  await delay();
  exigirRespuesta(await riesgoDb
    .from("evaluaciones")
    .update({ aprobado: false, motivo: "Anulada por fallo posterior en la pasarela" })
    .eq("idempotency_key", idempotencyKey), "anular evaluación");

  return { estado: "COMPENSADO", datos: {} };
}
