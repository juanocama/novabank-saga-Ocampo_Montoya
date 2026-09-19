# Contrato entre servicios y máquina de estados

## Secuencia de la Saga

| Paso | Servicio | Acción | Compensación |
|------|----------|--------|---------------|
| S1 | Account | Debitar cuenta origen | Reversar débito |
| S2 | Risk | Validar riesgo y fraude | Anular aprobación |
| S3 | Clearing | Liquidar interbancario | Anular liquidación |
| S4 | Account | Acreditar cuenta destino | Anular liquidación, riesgo y débito si falla |

Compensación en reversa: si falla S2 se compensa S1; si falla S3 se compensa S2 y luego S1; si falla S4 se compensa S3, S2 y luego S1.

## Contrato HTTP (usado por el orquestador de Prefect)

```json
// POST /runs en el worker interno; el gateway público sigue siendo
// POST /transferencias.
{
  "sagaId": "uuid-v4",
  "cuentaOrigen": "ORIGEN-001",
  "cuentaDestino": "DESTINO-001",
  "monto": 1000,
  "escenarioSimulado": null
}

// Respuesta
{ "estado": "EXITOSO", "datos": { }, "motivo": null }
```

## Eventos de dominio (usados en la coreografía vía RabbitMQ)

| Routing key | Publicado por | Consumido por | Datos relevantes |
|---|---|---|---|
| `transferencia.solicitada` | api-gateway | account-service | |
| `saldo.debitado` | account-service | risk-service | |
| `transferencia.rechazada.fondos` | account-service | (fin de saga) | |
| `transferencia.rechazada.destino` | account-service | api-gateway | |
| `riesgo.aprobado` | risk-service | clearing-service | |
| `riesgo.rechazado` | risk-service | account-service | `causa: "RIESGO"` |
| `liquidacion.exitosa` | clearing-service | account-service | |
| `liquidacion.fallida` | clearing-service | risk-service | `causa: "RED"` |
| `credito.fallido` | account-service | clearing-service | `causa: "DESTINO"` |
| `liquidacion.anulada` | clearing-service | risk-service | `causa: "DESTINO"` |
| `riesgo.anulado` | risk-service | account-service | conserva `causa` |
| `transferencia.confirmada` | account-service | — | |
| `transferencia.compensada` | account-service | — | conserva `causa` |

## Estados

Por paso: `PENDIENTE → EN_EJECUCION → EXITOSO | FALLIDO → COMPENSANDO → COMPENSADO`

Por saga completa: `CONFIRMADO`, `RECHAZADO_FONDOS`, `RECHAZADO_DESTINO`, `RECHAZADO_RIESGO`, `RECHAZADO_RED`.

## Endpoints públicos adicionales

- `GET /cuentas/{numeroCuenta}/saldo`: consulta el saldo actual.
- `POST /cuentas/reset`: restaura las cuentas de demo a 5000 y 1000.
- `GET /transferencias/{sagaId}/estado`: devuelve la saga y toda la bitácora inmutable.

## Movimiento atómico

`cuentas.aplicar_movimiento` bloquea la cuenta con `FOR UPDATE`, comprueba fondos,
actualiza el saldo e inserta el movimiento en una sola transacción. Las reversas
solo aceptan un débito original existente para la misma cuenta y llave; si no
existe devuelven `FALLIDO / DEBITO_ORIGINAL_NO_EXISTE` y nunca crean dinero.

## Reintentos RabbitMQ

Los consumidores reintentan hasta tres veces con dos segundos de espera y
transportan el contador en el header `x-retries`. Después publican el mensaje
en la cola durable `saga.dlq` para inspección posterior.
