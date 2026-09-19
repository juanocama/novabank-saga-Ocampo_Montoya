import express from "express";
import { debitar, reversarDebito, acreditar } from "./domain.js";
import { publicarEvento, suscribirse } from "./rabbitmq.js";
import { registrarPaso } from "./supabase.js";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get("/salud", (_req, res) => res.json({ ok: true, servicio: "account-service" }));

// ---------- Rutas HTTP: las usará el flujo de Prefect en la Saga orquestada ----------

app.post("/debitar", asyncHandler(async (req, res) => {
  const { sagaId, cuentaOrigen, cuentaDestino, monto } = req.body;
  const idempotencyKey = `${sagaId}:S1_DEBITO`;
  try {
    await registrarPaso(sagaId, "S1_DEBITO", "ORQUESTADA", "EN_EJECUCION");
    const resultado = await debitar({ sagaId, idempotencyKey, cuentaOrigen, cuentaDestino, monto });
    await registrarPaso(sagaId, "S1_DEBITO", "ORQUESTADA", resultado.estado, resultado);
    res.json(resultado);
  } catch (error) { res.status(502).json({ error: error.message }); }
}));

app.post("/debitar/compensar", asyncHandler(async (req, res) => {
  const { sagaId, cuentaOrigen, monto } = req.body;
  const idempotencyKey = `${sagaId}:S1_DEBITO`;
  await registrarPaso(sagaId, "S1_DEBITO", "ORQUESTADA", "COMPENSANDO");
  const resultado = await reversarDebito({ sagaId, idempotencyKey, cuentaOrigen, monto });
  await registrarPaso(sagaId, "S1_DEBITO", "ORQUESTADA", resultado.estado, resultado);
  res.json(resultado);
}));

app.post("/acreditar", asyncHandler(async (req, res) => {
  const { sagaId, cuentaDestino, monto } = req.body;
  const idempotencyKey = `${sagaId}:S4_CREDITO`;
  await registrarPaso(sagaId, "S4_CREDITO", "ORQUESTADA", "EN_EJECUCION");
  const resultado = await acreditar({ sagaId, idempotencyKey, cuentaDestino, monto });
  await registrarPaso(sagaId, "S4_CREDITO", "ORQUESTADA", resultado.estado, resultado);
  res.json(resultado);
}));

app.use((error, _req, res, _next) => {
  console.error("Error en account-service:", error);
  res.status(500).json({ error: "Error interno del servicio de cuentas" });
});

app.listen(PORT, () => console.log(`Account service escuchando en http://localhost:${PORT}`));

// ---------- Consumidor de eventos: hace posible la Saga coreografiada ----------

suscribirse(
  "account-service-queue",
  ["transferencia.solicitada", "liquidacion.exitosa", "riesgo.rechazado", "riesgo.anulado"],
  async (routingKey, evento) => {
    const { sagaId, cuentaOrigen, cuentaDestino, monto } = evento;

    if (routingKey === "transferencia.solicitada") {
      const idempotencyKey = `${sagaId}:S1_DEBITO`;
      await registrarPaso(sagaId, "S1_DEBITO", "COREOGRAFIADA", "EN_EJECUCION");
      const resultado = await debitar({ sagaId, idempotencyKey, cuentaOrigen, cuentaDestino, monto });
      await registrarPaso(sagaId, "S1_DEBITO", "COREOGRAFIADA", resultado.estado, resultado);

      if (resultado.estado === "EXITOSO") {
        await publicarEvento("saldo.debitado", evento);
      } else if (resultado.motivo === "CUENTA_DESTINO_NO_EXISTE") {
        await publicarEvento("transferencia.rechazada.destino", evento);
      } else {
        // Fondos insuficientes: rechazo inmediato, no hay nada que compensar (CP-02).
        await publicarEvento("transferencia.rechazada.fondos", evento);
      }
    }

    if (routingKey === "riesgo.rechazado" || routingKey === "riesgo.anulado") {
      const idempotencyKey = `${sagaId}:S1_DEBITO`;
      await registrarPaso(sagaId, "S1_DEBITO", "COREOGRAFIADA", "COMPENSANDO");
      const resultado = await reversarDebito({ sagaId, idempotencyKey, cuentaOrigen, monto });
      await registrarPaso(sagaId, "S1_DEBITO", "COREOGRAFIADA", resultado.estado, resultado);
      await publicarEvento("transferencia.compensada", evento);
    }

    if (routingKey === "liquidacion.exitosa") {
      const idempotencyKey = `${sagaId}:S4_CREDITO`;
      await registrarPaso(sagaId, "S4_CREDITO", "COREOGRAFIADA", "EN_EJECUCION");
      const resultado = await acreditar({ sagaId, idempotencyKey, cuentaDestino, monto });
      await registrarPaso(sagaId, "S4_CREDITO", "COREOGRAFIADA", resultado.estado, resultado);
      if (resultado.estado === "EXITOSO") {
        await publicarEvento("transferencia.confirmada", evento);
      } else {
        await publicarEvento("credito.fallido", { ...evento, causa: "DESTINO" });
      }
    }
  }
);
