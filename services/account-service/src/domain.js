import { cuentasDb, exigirRespuesta } from "./supabase.js";

const DELAY_MS = Number(process.env.DELAY_MS || 3000);

// Simula el trabajo real del paso para poder apreciar los estados
// intermedios en la capa de observabilidad (2 a 4 segundos, según el taller).
const delay = () => new Promise((r) => setTimeout(r, DELAY_MS));

async function movimiento({ sagaId, idempotencyKey, cuenta, tipo, monto }) {
  const filas = exigirRespuesta(await cuentasDb.rpc("aplicar_movimiento", {
    p_saga_id: sagaId,
    p_numero_cuenta: cuenta,
    p_tipo: tipo,
    p_monto: monto,
    p_idempotency_key: idempotencyKey,
  }), `aplicar ${tipo}`);
  return filas[0];
}

export async function debitar({ sagaId, idempotencyKey, cuentaOrigen, cuentaDestino, monto }) {
  await delay();
  if (cuentaDestino) {
    const destino = exigirRespuesta(await cuentasDb.from("cuentas_bancarias")
      .select("numero_cuenta").eq("numero_cuenta", cuentaDestino).maybeSingle(), "validar cuenta destino");
    if (!destino) return { estado: "FALLIDO", datos: {}, motivo: "CUENTA_DESTINO_NO_EXISTE" };
  }
  const resultado = await movimiento({ sagaId, idempotencyKey, cuenta: cuentaOrigen, tipo: "DEBITO", monto });
  return resultado.estado === "FALLIDO"
    ? { estado: "FALLIDO", datos: {}, motivo: resultado.motivo }
    : { estado: "EXITOSO", datos: { saldoResultante: resultado.saldo, duplicado: resultado.estado === "DUPLICADO" }, motivo: null };
}

export async function reversarDebito({ sagaId, idempotencyKey, cuentaOrigen, monto }) {
  await delay();

  const resultado = await movimiento({ sagaId, idempotencyKey, cuenta: cuentaOrigen, tipo: "REVERSA_DEBITO", monto });
  return resultado.estado === "FALLIDO"
    ? { estado: "FALLIDO", datos: {}, motivo: resultado.motivo }
    : { estado: "COMPENSADO", datos: { saldoRestituido: resultado.saldo, duplicado: resultado.estado === "DUPLICADO" } };
}

export async function acreditar({ sagaId, idempotencyKey, cuentaDestino, monto }) {
  await delay();

  const resultado = await movimiento({ sagaId, idempotencyKey, cuenta: cuentaDestino, tipo: "CREDITO", monto });
  return resultado.estado === "FALLIDO"
    ? { estado: "FALLIDO", datos: {}, motivo: resultado.motivo }
    : { estado: "EXITOSO", datos: { saldoResultante: resultado.saldo, duplicado: resultado.estado === "DUPLICADO" }, motivo: null };
}
