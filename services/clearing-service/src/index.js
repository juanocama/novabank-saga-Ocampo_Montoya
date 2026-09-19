import express from "express";
import { liquidar, anularLiquidacion } from "./domain.js";
import { publicarEvento, suscribirse } from "./rabbitmq.js";
import { registrarPaso } from "./supabase.js";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3003;
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get("/salud", (_req, res) => res.json({ ok: true, servicio: "clearing-service" }));

// ---------- Rutas HTTP: las usará el flujo de Prefect en la Saga orquestada ----------

app.post("/liquidar", asyncHandler(async (req, res) => {
  const { sagaId, monto, escenarioSimulado } = req.body;
  const idempotencyKey = `${sagaId}:S3_LIQUIDACION`;
  try {
    await registrarPaso(sagaId, "S3_LIQUIDACION", "ORQUESTADA", "EN_EJECUCION");
    const resultado = await liquidar({ sagaId, idempotencyKey, monto, escenarioSimulado });
    await registrarPaso(sagaId, "S3_LIQUIDACION", "ORQUESTADA", resultado.estado, resultado);
    res.json(resultado);
  } catch (error) { res.status(502).json({ error: error.message }); }
}));

app.post("/liquidar/compensar", asyncHandler(async (req, res) => {
  const { sagaId } = req.body;
  const idempotencyKey = `${sagaId}:S3_LIQUIDACION`;
  await registrarPaso(sagaId, "S3_LIQUIDACION", "ORQUESTADA", "COMPENSANDO");
  const resultado = await anularLiquidacion({ idempotencyKey });
  await registrarPaso(sagaId, "S3_LIQUIDACION", "ORQUESTADA", resultado.estado, resultado);
  res.json(resultado);
}));

app.use((error, _req, res, _next) => {
  console.error("Error en clearing-service:", error);
  res.status(500).json({ error: "Error interno del servicio de liquidación" });
});

app.listen(PORT, () => console.log(`Clearing service escuchando en http://localhost:${PORT}`));

// ---------- Consumidor de eventos: hace posible la Saga coreografiada ----------

suscribirse("clearing-service-queue", ["riesgo.aprobado", "credito.fallido"], async (routingKey, evento) => {
  if (routingKey === "credito.fallido") {
    const { sagaId } = evento;
    const idempotencyKey = `${sagaId}:S3_LIQUIDACION`;
    await registrarPaso(sagaId, "S3_LIQUIDACION", "COREOGRAFIADA", "COMPENSANDO");
    const resultado = await anularLiquidacion({ idempotencyKey });
    await registrarPaso(sagaId, "S3_LIQUIDACION", "COREOGRAFIADA", resultado.estado, resultado);
    await publicarEvento("liquidacion.anulada", { ...evento, causa: "DESTINO" });
    return;
  }

  const { sagaId, monto, escenarioSimulado } = evento;
  const idempotencyKey = `${sagaId}:S3_LIQUIDACION`;

  await registrarPaso(sagaId, "S3_LIQUIDACION", "COREOGRAFIADA", "EN_EJECUCION");
  const resultado = await liquidar({ sagaId, idempotencyKey, monto, escenarioSimulado });
  await registrarPaso(sagaId, "S3_LIQUIDACION", "COREOGRAFIADA", resultado.estado, resultado);

  if (resultado.estado === "EXITOSO") {
    await publicarEvento("liquidacion.exitosa", evento);
  } else {
    // CP-04: dispara la cascada de compensación hacia riesgo y luego hacia la cuenta.
    await publicarEvento("liquidacion.fallida", { ...evento, causa: "RED" });
  }
});
