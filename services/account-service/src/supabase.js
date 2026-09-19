import { createClient } from "@supabase/supabase-js";
import ws from "ws";

export const cuentasDb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { db: { schema: "cuentas" }, realtime: { transport: ws } }
);

export const auditoriaDb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { db: { schema: "auditoria" }, realtime: { transport: ws } }
);

export function exigirRespuesta(respuesta, operacion) {
  if (respuesta.error) throw new Error(`${operacion}: ${respuesta.error.message}`);
  return respuesta.data;
}

// Registra el avance de un paso de la saga para que el frontend lo vea por polling.
export async function registrarPaso(sagaId, paso, modo, estado, detalle = null) {
  exigirRespuesta(await auditoriaDb.from("pasos_saga").insert({
    saga_id: sagaId,
    paso,
    modo,
    estado,
    detalle,
  }), "registrar paso");
}
