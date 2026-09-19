# NovaBank Saga

video evidencia: https://youtu.be/Z_uHd1MkKhI

NovaBank Saga es un simulador de transferencias bancarias distribuido. Su objetivo
es mostrar cómo una operación que atraviesa varios microservicios puede mantener
un resultado consistente sin depender de una transacción distribuida global.

La operación usa el patrón **Saga** y puede ejecutarse de dos formas:

- **Orquestada:** Prefect coordina explícitamente cada paso y decide cuándo compensar.
- **Coreografiada:** los servicios reaccionan a eventos de RabbitMQ sin un coordinador central.

Ambos modos ejecutan las mismas reglas de negocio, escriben la misma bitácora y
exponen el mismo contrato HTTP al frontend.

## Cómo funciona una transferencia

El frontend envía una transferencia al API Gateway. El gateway valida la petición,
crea el identificador de la saga, registra su estado inicial y arranca el modo
seleccionado. El flujo de negocio es:

| Paso | Servicio | Operación | Compensación |
| --- | --- | --- | --- |
| S1 | Account | Debitar la cuenta de origen | Reversar el débito |
| S2 | Risk | Validar riesgo y fraude | Anular la aprobación |
| S3 | Clearing | Liquidar la operación interbancaria | Anular la liquidación |
| S4 | Account | Acreditar la cuenta de destino | Ejecutar S3, S2 y S1 en reversa |

Una saga exitosa termina en `CONFIRMADO`. Si un paso falla, se ejecutan las
compensaciones necesarias en orden inverso y la saga termina en `RECHAZADO_FONDOS`,
`RECHAZADO_DESTINO`, `RECHAZADO_RIESGO` o `RECHAZADO_RED`.

Cada paso se registra como `PENDIENTE`, `EN_EJECUCION`, `EXITOSO`, `FALLIDO`,
`COMPENSANDO` o `COMPENSADO`. El frontend consulta esa bitácora mediante polling
para mostrar el avance de la saga sin usar WebSockets.

## Orquestación y coreografía

### Modo orquestado

El gateway envía un `POST /runs` al worker `saga-orchestrator`. El worker ejecuta
con Prefect S1, S2, S3 y S4 como tareas HTTP independientes. Si una tarea falla,
Prefect reintenta las compensaciones y el flujo actualiza el estado final en
Supabase.

### Modo coreografiado

El gateway publica `transferencia.solicitada` en RabbitMQ. Después, cada servicio
publica el siguiente evento cuando termina su parte:

```text
transferencia.solicitada
  -> saldo.debitado
  -> riesgo.aprobado
  -> liquidacion.exitosa
  -> transferencia.confirmada
```

Los rechazos publican eventos de compensación. Por ejemplo, un fallo de red en
Clearing provoca `liquidacion.fallida`, después `riesgo.anulado` y finalmente la
reversa del débito. Los consumidores reintentan hasta tres veces y envían los
mensajes que no pueden procesar a la cola durable `saga.dlq`.

## Consistencia, idempotencia y persistencia

Cada microservicio tiene su propio esquema dentro de Supabase: `cuentas`,
`riesgo`, `pasarela` y `auditoria`. Esto representa el aislamiento lógico de la
persistencia por dominio:

- `cuentas` mantiene saldos y movimientos.
- `riesgo` mantiene las evaluaciones de riesgo.
- `pasarela` mantiene liquidaciones y anulaciones.
- `auditoria` mantiene la saga y sus pasos para consulta del frontend.

El movimiento de una cuenta usa `cuentas.aplicar_movimiento`, que bloquea la fila
con `FOR UPDATE`, valida fondos, actualiza el saldo y registra el movimiento en
una sola transacción. Las llaves de idempotencia impiden repetir débitos,
créditos o compensaciones.

En el nivel de la saga, `idempotencyKey` puede reutilizarse para reenviar una
petición sin generar un doble cobro. El gateway devuelve la saga existente y no
vuelve a iniciar el flujo.

## Componentes

```text
frontend/                   Panel React/TypeScript del simulador
services/api-gateway/       Entrada HTTP, idempotencia y selección de modo
services/account-service/   Débitos, créditos y reversas
services/risk-service/      Evaluación de riesgo y compensación
services/clearing-service/  Liquidación interbancaria y compensación
saga-orchestrator/          Worker FastAPI/Prefect para el modo orquestado
RabbitMQ                    Transporte de eventos del modo coreografiado
Supabase                    Persistencia aislada y auditoría
```

## API y escenarios de demostración

El endpoint principal es `POST /transferencias` y recibe `modo`, `cuentaOrigen`,
`cuentaDestino`, `monto`, `escenarioSimulado` y, de forma opcional,
`idempotencyKey`. Los escenarios simulables son:

| Escenario | Resultado esperado |
| --- | --- |
| Transferencia válida | Saga confirmada |
| Monto mayor al saldo | `RECHAZADO_FONDOS` |
| `FORZAR_RIESGO` | `RECHAZADO_RIESGO` y reversa del débito |
| `FORZAR_TIMEOUT_RED` | `RECHAZADO_RED` y compensaciones previas |
| Reenvío con la misma llave | Respuesta duplicada sin nuevo movimiento |

También están disponibles `GET /transferencias/{sagaId}/estado`,
`GET /cuentas/{numeroCuenta}/saldo` y `POST /cuentas/reset`. El último endpoint
solo existe para devolver las cuentas de demostración a `ORIGEN-001 = 5000` y
`DESTINO-001 = 1000`; no debe exponerse como operación de producción.

Los contratos completos, eventos y estados están en [docs/contratos.md](docs/contratos.md).

## Puesta en marcha

1. Crea un proyecto en [Supabase](https://supabase.com).
2. Ejecuta `supabase/schema.sql` completo desde el SQL Editor. Crea los cuatro
   esquemas, permisos, función de movimiento atómico y cuentas de prueba.
3. En **Settings > API > Data API > Exposed schemas**, agrega `cuentas`,
   `riesgo`, `pasarela` y `auditoria`.
4. Copia `.env.example` a `.env` y completa `SUPABASE_URL` y
   `SUPABASE_SERVICE_ROLE_KEY` desde **Project Settings > API**.
5. Construye y levanta los servicios:

   ```bash
   docker compose up --build
   ```

6. Comprueba la salud del gateway y los servicios de dominio:

   ```bash
   curl http://localhost:3000/salud
   curl http://localhost:3001/salud
   curl http://localhost:3002/salud
   curl http://localhost:3003/salud
   curl http://localhost:8000/salud
   ```

7. Abre el panel en http://localhost:5173. Las interfaces auxiliares están en
   RabbitMQ (http://localhost:15672, `guest`/`guest`) y Prefect
   (http://localhost:4200).

Para iniciar una saga manualmente:

```bash
curl -X POST http://localhost:3000/transferencias \
  -H "Content-Type: application/json" \
  -d '{"modo":"COREOGRAFIADA","cuentaOrigen":"ORIGEN-001","cuentaDestino":"DESTINO-001","monto":500}'
```

Guarda el `sagaId` devuelto y consulta su avance con:

```bash
curl http://localhost:3000/transferencias/<sagaId>/estado
```
