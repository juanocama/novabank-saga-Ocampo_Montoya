import express from "express";
import { evaluarRiesgo, anularAprobacion } from "./domain.js";
import { publicarEvento, suscribirse } from "./rabbitmq.js";
import { registrarPaso } from "./supabase.js";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3002;
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get("/salud", (_req, res) => res.json({ ok: true, servicio: "risk-service" }));

// ---------- Rutas HTTP: las usará el flujo de Prefect en la Saga orquestada ----------

app.post("/validar-riesgo", asyncHandler(async (req, res) => {
  const { sagaId, cuentaOrigen, monto, escenarioSimulado } = req.body;
  const idempotencyKey = `${sagaId}:S2_RIESGO`;
  try {
    await registrarPaso(sagaId, "S2_RIESGO", "ORQUESTADA", "EN_EJECUCION");
    const resultado = await evaluarRiesgo({ sagaId, idempotencyKey, cuentaOrigen, monto, escenarioSimulado });
    await registrarPaso(sagaId, "S2_RIESGO", "ORQUESTADA", resultado.estado, resultado);
    res.json(resultado);
  } catch (error) { res.status(502).json({ error: error.message }); }
}));

app.post("/validar-riesgo/compensar", asyncHandler(async (req, res) => {
  const { sagaId } = req.body;
  const idempotencyKey = `${sagaId}:S2_RIESGO`;
  await registrarPaso(sagaId, "S2_RIESGO", "ORQUESTADA", "COMPENSANDO");
  const resultado = await anularAprobacion({ sagaId, idempotencyKey });
  await registrarPaso(sagaId, "S2_RIESGO", "ORQUESTADA", resultado.estado, resultado);
  res.json(resultado);
}));

app.use((error, _req, res, _next) => {
  console.error("Error en risk-service:", error);
  res.status(500).json({ error: "Error interno del servicio de riesgo" });
});

app.listen(PORT, () => console.log(`Risk service escuchando en http://localhost:${PORT}`));

// ---------- Consumidor de eventos: hace posible la Saga coreografiada ----------

suscribirse(
  "risk-service-queue",
  ["saldo.debitado", "liquidacion.fallida", "liquidacion.anulada"],
  async (routingKey, evento) => {
    const { sagaId, cuentaOrigen, monto, escenarioSimulado } = evento;

    if (routingKey === "saldo.debitado") {
      const idempotencyKey = `${sagaId}:S2_RIESGO`;
      await registrarPaso(sagaId, "S2_RIESGO", "COREOGRAFIADA", "EN_EJECUCION");
      const resultado = await evaluarRiesgo({ sagaId, idempotencyKey, cuentaOrigen, monto, escenarioSimulado });
      await registrarPaso(sagaId, "S2_RIESGO", "COREOGRAFIADA", resultado.estado, resultado);

      if (resultado.estado === "EXITOSO") {
        await publicarEvento("riesgo.aprobado", evento);
      } else {
        // CP-03: el propio servicio de riesgo dispara el evento de fallo;
        // account-service reacciona solo y compensa el débito.
        await publicarEvento("riesgo.rechazado", { ...evento, causa: "RIESGO" });
      }
    }

    if (routingKey === "liquidacion.fallida" || routingKey === "liquidacion.anulada") {
      const idempotencyKey = `${sagaId}:S2_RIESGO`;
      await registrarPaso(sagaId, "S2_RIESGO", "COREOGRAFIADA", "COMPENSANDO");
      const resultado = await anularAprobacion({ sagaId, idempotencyKey });
      await registrarPaso(sagaId, "S2_RIESGO", "COREOGRAFIADA", resultado.estado, resultado);
      // CP-04: en cascada, account-service compensa el débito al recibir esto.
      await publicarEvento("riesgo.anulado", evento);
    }
  }
);
