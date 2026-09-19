"""Worker HTTP que dispara los flujos de Prefect de la saga orquestada."""

import httpx
from fastapi import FastAPI, status
from prefect import flow, get_run_logger, task
from pydantic import BaseModel
from threading import Thread

ACCOUNT_URL = "http://account-service:3001"
RISK_URL = "http://risk-service:3002"
CLEARING_URL = "http://clearing-service:3003"
SUPABASE_URL = __import__("os").environ["SUPABASE_URL"]
SUPABASE_KEY = __import__("os").environ["SUPABASE_SERVICE_ROLE_KEY"]
app = FastAPI()


class RunRequest(BaseModel):
    sagaId: str
    cuentaOrigen: str
    cuentaDestino: str
    monto: float
    escenarioSimulado: str | None = None


class BusinessFailure(RuntimeError):
    """Marca un rechazo de negocio después de completar su compensación."""


@task(retries=0)
def debitar_origen(saga_id, cuenta_origen, cuenta_destino, monto):
    r = httpx.post(f"{ACCOUNT_URL}/debitar", json={"sagaId": saga_id, "cuentaOrigen": cuenta_origen, "cuentaDestino": cuenta_destino, "monto": monto}, timeout=30)
    r.raise_for_status()
    return r.json()


@task(retries=3, retry_delay_seconds=2)
def compensar_debito(saga_id, cuenta_origen, monto):
    response = httpx.post(f"{ACCOUNT_URL}/debitar/compensar", json={"sagaId": saga_id, "cuentaOrigen": cuenta_origen, "monto": monto}, timeout=10)
    response.raise_for_status()
    return response.json()


@task(retries=0)
def validar_riesgo(saga_id, cuenta_origen, monto, escenario_simulado):
    r = httpx.post(f"{RISK_URL}/validar-riesgo", json={"sagaId": saga_id, "cuentaOrigen": cuenta_origen, "monto": monto, "escenarioSimulado": escenario_simulado}, timeout=30)
    r.raise_for_status()
    return r.json()


@task(retries=3, retry_delay_seconds=2)
def compensar_riesgo(saga_id):
    response = httpx.post(f"{RISK_URL}/validar-riesgo/compensar", json={"sagaId": saga_id}, timeout=10)
    response.raise_for_status()
    return response.json()


@task(retries=0)
def liquidar(saga_id, monto, escenario_simulado):
    r = httpx.post(f"{CLEARING_URL}/liquidar", json={"sagaId": saga_id, "monto": monto, "escenarioSimulado": escenario_simulado}, timeout=30)
    r.raise_for_status()
    return r.json()


@task(retries=3, retry_delay_seconds=2)
def compensar_liquidacion(saga_id):
    response = httpx.post(f"{CLEARING_URL}/liquidar/compensar", json={"sagaId": saga_id}, timeout=10)
    response.raise_for_status()
    return response.json()


@task(retries=0)
def acreditar_destino(saga_id, cuenta_destino, monto):
    r = httpx.post(f"{ACCOUNT_URL}/acreditar", json={"sagaId": saga_id, "cuentaDestino": cuenta_destino, "monto": monto}, timeout=30)
    r.raise_for_status()
    return r.json()


def estado_final(saga_id, estado):
    r = httpx.patch(
        f"{SUPABASE_URL}/rest/v1/sagas?saga_id=eq.{saga_id}",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Profile": "auditoria"},
        json={"estado_final": estado}, timeout=10,
    )
    r.raise_for_status()


def compensacion_s1(saga_id, cuenta_origen, monto):
    resultado = compensar_debito(saga_id, cuenta_origen, monto)
    if resultado.get("estado") == "FALLIDO" and resultado.get("motivo") == "DEBITO_ORIGINAL_NO_EXISTE":
        return
    if resultado.get("estado") != "COMPENSADO":
        raise RuntimeError(f"Compensación S1 no completada: {resultado}")


def compensar_intentos(saga_id, cuenta_origen, monto, intentados):
    """Compensa solo pasos que pudieron haber tocado estado, en orden inverso."""
    for paso in reversed(intentados):
        if paso == "S3":
            resultado = compensar_liquidacion(saga_id)
            if resultado.get("estado") != "COMPENSADO":
                raise RuntimeError(f"Compensación S3 no completada: {resultado}")
        elif paso == "S2":
            resultado = compensar_riesgo(saga_id)
            if resultado.get("estado") != "COMPENSADO":
                raise RuntimeError(f"Compensación S2 no completada: {resultado}")
        elif paso == "S1":
            compensacion_s1(saga_id, cuenta_origen, monto)


@flow(name="saga-orquestada-transferencia")
def saga_transferencia(saga_id: str, cuenta_origen: str, cuenta_destino: str, monto: float, escenario_simulado: str | None = None):
    logger = get_run_logger()
    intentados = []
    compensables = []
    resultado_final = None
    try:
        # S1 se considera intentado antes del POST: un timeout no permite saber si debitó.
        intentados.append("S1")
        r1 = debitar_origen(saga_id, cuenta_origen, cuenta_destino, monto)
        if r1["estado"] == "FALLIDO":
            resultado_final = "RECHAZADO_DESTINO" if r1.get("motivo") == "CUENTA_DESTINO_NO_EXISTE" else "RECHAZADO_FONDOS"
            compensar_intentos(saga_id, cuenta_origen, monto, intentados)
            estado_final(saga_id, resultado_final)
            raise BusinessFailure(resultado_final)
        compensables.append("S1")

        intentados.append("S2")
        r2 = validar_riesgo(saga_id, cuenta_origen, monto, escenario_simulado)
        if r2["estado"] == "FALLIDO":
            # S2 no aprobó una operación, por lo que solo se devuelve el débito.
            compensar_intentos(saga_id, cuenta_origen, monto, ["S1"])
            estado_final(saga_id, "RECHAZADO_RIESGO")
            raise BusinessFailure("RECHAZADO_RIESGO")
        compensables.append("S2")

        intentados.append("S3")
        r3 = liquidar(saga_id, monto, escenario_simulado)
        if r3["estado"] == "FALLIDO":
            compensar_intentos(saga_id, cuenta_origen, monto, ["S1", "S2"])
            estado_final(saga_id, "RECHAZADO_RED")
            raise BusinessFailure("RECHAZADO_RED")
        compensables.append("S3")

        intentados.append("S4")
        final = acreditar_destino(saga_id, cuenta_destino, monto)
        if final["estado"] == "FALLIDO":
            compensar_intentos(saga_id, cuenta_origen, monto, ["S3", "S2", "S1"])
            estado_final(saga_id, "RECHAZADO_DESTINO")
            raise BusinessFailure("RECHAZADO_DESTINO")
        estado_final(saga_id, "CONFIRMADO")
        return {"estadoFinal": "CONFIRMADO"}
    except BusinessFailure:
        raise
    except Exception as error:
        logger.error("Fallo técnico en la saga %s: %s", saga_id, error)
        try:
            pasos_compensables = list(compensables)
            if "S1" in intentados and "S1" not in pasos_compensables:
                pasos_compensables.append("S1")
            compensar_intentos(saga_id, cuenta_origen, monto, pasos_compensables)
            estado_final(saga_id, "RECHAZADO_RED")
        except Exception as compensacion_error:
            logger.exception("Compensación incompleta para %s; estado_final queda null: %s", saga_id, compensacion_error)
            raise RuntimeError(f"Compensación incompleta: {compensacion_error}") from compensacion_error
        raise


@app.get("/salud")
def health():
    return {"ok": True, "servicio": "saga-orchestrator"}


@app.post("/runs", status_code=status.HTTP_202_ACCEPTED)
def start_run(request: RunRequest):
    Thread(target=saga_transferencia, kwargs={
        "saga_id": request.sagaId, "cuenta_origen": request.cuentaOrigen,
        "cuenta_destino": request.cuentaDestino, "monto": request.monto,
        "escenario_simulado": request.escenarioSimulado,
    }, daemon=True).start()
    return {"estado": "PENDIENTE", "sagaId": request.sagaId}


if __name__ == "__main__":
    # Prueba manual del camino feliz (CP-01)
    resultado = saga_transferencia("00000000-0000-4000-8000-000000000001", "ORIGEN-001", "DESTINO-001", 500)
    print(resultado)
