import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { supabase, cuentasDb } from "./supabase.js";
import { publicarEvento, suscribirse } from "./rabbitmq.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Modos posibles del switch que enviará el frontend
const MODOS = { ORQUESTADA: "ORQUESTADA", COREOGRAFIADA: "COREOGRAFIADA" };
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://saga-orchestrator:8000";
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get("/salud", (_req, res) => res.json({ ok: true, servicio: "api-gateway" }));

/**
 * Punto de entrada único del frontend.
 * Body esperado:
 * {
 *   "idempotencyKey": "uuid opcional (reenvíalo igual para probar CP-05)",
 *   "modo": "ORQUESTADA" | "COREOGRAFIADA",
 *   "cuentaOrigen": "ORIGEN-001",
 *   "cuentaDestino": "DESTINO-001",
 *   "monto": 1000,
 *   "escenarioSimulado": null | "FONDOS_INSUFICIENTES" | "FORZAR_RIESGO" | "FORZAR_TIMEOUT_RED"
 * }
 */
app.post("/transferencias", asyncHandler(async (req, res) => {
  const {
    idempotencyKey,
    modo,
    cuentaOrigen,
    cuentaDestino,
    monto,
    escenarioSimulado = null,
  } = req.body;

  if (!modo || !MODOS[modo]) {
    return res.status(400).json({ error: "El campo 'modo' debe ser ORQUESTADA o COREOGRAFIADA" });
  }
  if (!cuentaOrigen || !cuentaDestino || !Number.isFinite(Number(monto)) || Number(monto) <= 0) {
    return res.status(400).json({ error: "cuentaOrigen, cuentaDestino y monto son obligatorios" });
  }

  // CP-05: si ya existe una saga con este idempotencyKey, la devolvemos tal cual
  // en vez de volver a ejecutar nada. Usamos el propio sagaId como llave de
  // idempotencia expuesta al cliente, es más simple de reenviar desde el frontend.
  const sagaId = idempotencyKey || uuidv4();

  const { data: existente, error: consultaError } = await supabase
    .from("sagas")
    .select("*")
    .eq("saga_id", sagaId)
    .maybeSingle();

  if (consultaError) return res.status(502).json({ error: `No se pudo consultar idempotencia: ${consultaError.message}` });
  if (existente) {
    return res.status(200).json({
      sagaId,
      duplicado: true,
      mensaje: "Ya existe una saga con este identificador. No se ejecutan dobles cobros.",
      saga: existente,
    });
  }

  const { error: sagaError } = await supabase.from("sagas").insert({
    saga_id: sagaId,
    modo,
    cuenta_origen: cuentaOrigen,
    cuenta_destino: cuentaDestino,
    monto,
    escenario_simulado: escenarioSimulado,
  });
  if (sagaError) return res.status(502).json({ error: `No se pudo registrar la saga: ${sagaError.message}` });

  const { error: pasoError } = await supabase.from("pasos_saga").insert({
    saga_id: sagaId,
    paso: "S1_DEBITO",
    modo,
    estado: "PENDIENTE",
  });
  if (pasoError) return res.status(502).json({ error: `No se pudo registrar el paso: ${pasoError.message}` });

  if (modo === MODOS.COREOGRAFIADA) {
    // Sin coordinador: publicamos el evento inicial y cada servicio reacciona solo.
    await publicarEvento("transferencia.solicitada", {
      sagaId,
      cuentaOrigen,
      cuentaDestino,
      monto,
      escenarioSimulado,
    });
  } else {
    try {
      const respuesta = await fetch(`${ORCHESTRATOR_URL}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sagaId, cuentaOrigen, cuentaDestino, monto, escenarioSimulado }),
      });
      if (!respuesta.ok) throw new Error(`orquestador respondió ${respuesta.status}`);
    } catch (error) {
      const { error: pasosDeleteError } = await supabase.from("pasos_saga").delete().eq("saga_id", sagaId);
      const { error: sagaDeleteError } = await supabase.from("sagas").delete().eq("saga_id", sagaId);
      if (pasosDeleteError || sagaDeleteError) {
        return res.status(502).json({ error: `No se pudo iniciar la saga orquestada ni limpiar su registro: ${(pasosDeleteError || sagaDeleteError).message}` });
      }
      return res.status(502).json({ error: `No se pudo iniciar la saga orquestada: ${error.message}` });
    }
  }

  res.status(202).json({ sagaId, modo, estado: "PENDIENTE" });
}));

app.get("/cuentas/:numeroCuenta/saldo", asyncHandler(async (req, res) => {
  const { data, error } = await cuentasDb.from("cuentas_bancarias").select("numero_cuenta,saldo,actualizado_en").eq("numero_cuenta", req.params.numeroCuenta).maybeSingle();
  if (error) return res.status(502).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Cuenta no encontrada" });
  res.json(data);
}));

app.post("/cuentas/reset", asyncHandler(async (_req, res) => {
  const [origen, destino] = await Promise.all([
    cuentasDb.from("cuentas_bancarias").update({ saldo: 5000 }).eq("numero_cuenta", "ORIGEN-001"),
    cuentasDb.from("cuentas_bancarias").update({ saldo: 1000 }).eq("numero_cuenta", "DESTINO-001"),
  ]);
  const error = origen.error || destino.error;
  if (error) return res.status(502).json({ error: error.message });
  res.json({ ok: true, cuentas: { "ORIGEN-001": 5000, "DESTINO-001": 1000 } });
}));

/**
 * El frontend hace polling a este endpoint (cada 1s aprox.) para pintar
 * el avance paso a paso en tiempo real, sin necesidad de WebSockets.
 */
app.get("/transferencias/:sagaId/estado", asyncHandler(async (req, res) => {
  const { sagaId } = req.params;

  const { data: saga, error: sagaError } = await supabase
    .from("sagas")
    .select("*")
    .eq("saga_id", sagaId)
    .maybeSingle();

  if (sagaError) return res.status(502).json({ error: sagaError.message });
  if (!saga) return res.status(404).json({ error: "Saga no encontrada" });

  const { data: pasos, error: pasosError } = await supabase
    .from("pasos_saga")
    .select("*")
    .eq("saga_id", sagaId)
    .order("actualizado_en", { ascending: true });

  if (pasosError) return res.status(502).json({ error: pasosError.message });
  res.json({ saga, pasos });
}));

suscribirse("api-gateway-terminal", ["transferencia.rechazada.fondos", "transferencia.rechazada.destino", "transferencia.compensada", "transferencia.confirmada"], async (routingKey, evento) => {
  const estado = routingKey === "transferencia.confirmada" ? "CONFIRMADO"
    : routingKey === "transferencia.rechazada.fondos" ? "RECHAZADO_FONDOS"
      : routingKey === "transferencia.rechazada.destino" ? "RECHAZADO_DESTINO"
        : evento.causa === "DESTINO" ? "RECHAZADO_DESTINO"
          : evento.causa === "RED" ? "RECHAZADO_RED" : "RECHAZADO_RIESGO";
  const { error } = await supabase.from("sagas").update({ estado_final: estado }).eq("saga_id", evento.sagaId);
  if (error) throw error;
});

app.use((error, _req, res, _next) => {
  console.error("Error en api-gateway:", error);
  res.status(500).json({ error: "Error interno del gateway" });
});

app.listen(PORT, () => {
  console.log(`API Gateway escuchando en http://localhost:${PORT}`);
});
