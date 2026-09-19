import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Check,
  CheckCircle2, ChevronDown, ChevronUp, Circle, Clock3, Copy, ExternalLink,
  Gauge, GitBranch, LoaderCircle, LockKeyhole, RefreshCw, RotateCcw, Settings,
  ShieldAlert, Sparkles, Terminal, TimerReset, WalletCards, X, XCircle, Zap,
} from "lucide-react";

type Mode = "ORQUESTADA" | "COREOGRAFIADA";
type Chaos = "FONDOS_INSUFICIENTES" | "FORZAR_RIESGO" | "FORZAR_TIMEOUT_RED" | null;
type SagaStatus = "CONFIRMADO" | "RECHAZADO_FONDOS" | "RECHAZADO_DESTINO" | "RECHAZADO_RIESGO" | "RECHAZADO_RED" | string | null;
type StepState = "PENDIENTE" | "EN_EJECUCION" | "EXITOSO" | "FALLIDO" | "COMPENSANDO" | "COMPENSADO";
type StepName = "S1_DEBITO" | "S2_RIESGO" | "S3_LIQUIDACION" | "S4_CREDITO";

type Detail = { estado?: string; datos?: Record<string, unknown>; motivo?: string } | null;
type Step = { id: string; saga_id: string; paso: StepName; modo: Mode; estado: StepState; detalle: Detail; actualizado_en: string };
type Saga = { saga_id: string; modo: Mode; cuenta_origen: string; cuenta_destino: string; monto: number; escenario_simulado: Chaos; estado_final: SagaStatus; creado_en: string };
type StateResponse = { saga: Saga; pasos: Step[] };
type Balance = { numero_cuenta: string; saldo: number; actualizado_en: string };
type RequestBody = { idempotencyKey: string; modo: Mode; cuentaOrigen: string; cuentaDestino: string; monto: number; escenarioSimulado: Chaos };

const steps: { id: StepName; title: string; service: string }[] = [
  { id: "S1_DEBITO", title: "Débito en cuenta origen", service: "Servicio de Cuentas" },
  { id: "S2_RIESGO", title: "Validación de riesgo y fraude", service: "Servicio de Riesgo" },
  { id: "S3_LIQUIDACION", title: "Liquidación interbancaria", service: "Pasarela" },
  { id: "S4_CREDITO", title: "Crédito en cuenta destino", service: "Servicio de Cuentas" },
];
const apiErrorCopy = (url: string) => `No se pudo conectar con el API en ${url}. Verifica que docker compose esté corriendo. Si abriste esta página desde una URL https, tu navegador puede bloquear llamadas a localhost: concede el permiso de red local o ejecuta el frontend en local.`;
const finalCopy: Record<string, string> = {
  CONFIRMADO: "Transferencia confirmada. Débito y crédito aplicados.",
  RECHAZADO_FONDOS: "Rechazada por fondos insuficientes. No hubo nada que compensar.",
  RECHAZADO_DESTINO: "Rechazada: la cuenta destino no existe. Cualquier débito fue reintegrado.",
  RECHAZADO_RIESGO: "Rechazada por riesgo o fraude. Se reintegró el débito.",
  RECHAZADO_RED: "Falló la pasarela interbancaria. Se anuló la aprobación de riesgo y se reintegró el débito.",
};
const stateIcon: Record<StepState, typeof Check> = {
  PENDIENTE: Circle, EN_EJECUCION: LoaderCircle, EXITOSO: Check, FALLIDO: X,
  COMPENSANDO: RotateCcw, COMPENSADO: CheckCircle2,
};

function useApi(baseUrl: string) {
  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try { response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }); }
    catch { throw new Error(apiErrorCopy(baseUrl)); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `El API respondió con ${response.status}.`);
    return payload as T;
  };
}

function formatMoney(value: number | string) { return new Intl.NumberFormat("es-CO", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value)); }
function formatTime(value: string) { const date = new Date(value); const time = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); return `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`; }
function formatDelta(value: number) { return `${value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`; }

function Badge({ state }: { state: StepState | SagaStatus }) {
  const normalized = state || "PENDIENTE";
  const Icon = normalized in stateIcon ? stateIcon[normalized as StepState] : Circle;
  return <span className={`status-badge status-${normalized.toLowerCase()}`}><Icon size={13} />{normalized.replaceAll("_", " ")}</span>;
}

function App() {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem("novabank_api_url") || "http://localhost:3000");
  const [draftUrl, setDraftUrl] = useState(apiUrl);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("ORQUESTADA");
  const [origin, setOrigin] = useState("ORIGEN-001");
  const [destination, setDestination] = useState("DESTINO-001");
  const [amount, setAmount] = useState(500);
  const [chaos, setChaos] = useState<Chaos>(null);
  const [originBalance, setOriginBalance] = useState<Balance | null>(null);
  const [destinationBalance, setDestinationBalance] = useState<Balance | null>(null);
  const [previousBalances, setPreviousBalances] = useState({ origin: 5000, destination: 1000 });
  const [sagaState, setSagaState] = useState<StateResponse | null>(null);
  const [lastRequest, setLastRequest] = useState<RequestBody | null>(null);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<{ kind: "error" | "success" | "info"; message: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const runStartedAt = useRef<number | null>(null);
  const api = useApi(apiUrl);

  const notify = (message: string, kind: "error" | "success" | "info" = "error") => setToast({ message, kind });
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4800); return () => window.clearTimeout(timer); }, [toast]);

  const checkConnection = async () => { try { await api<{ ok: boolean }>("/salud"); setConnected(true); } catch { setConnected(false); } };
  const loadBalances = async () => {
    try {
      const [nextOrigin, nextDestination] = await Promise.all([api<Balance>(`/cuentas/${origin}/saldo`), api<Balance>(`/cuentas/${destination}/saldo`)]);
      setOriginBalance(nextOrigin); setDestinationBalance(nextDestination);
    } catch (error) { if (error instanceof Error) notify(error.message); }
  };
  useEffect(() => { checkConnection(); const timer = window.setInterval(checkConnection, 10000); return () => window.clearInterval(timer); }, [apiUrl]);
  useEffect(() => { loadBalances(); }, [origin, destination, apiUrl]);
  useEffect(() => {
    if (!running || !sagaState?.saga.saga_id) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await api<StateResponse>(`/transferencias/${sagaState.saga.saga_id}/estado`);
        if (!active) return;
        setSagaState(next); await loadBalances();
        if (next.saga.estado_final) { setRunning(false); await loadBalances(); return; }
        if (runStartedAt.current && Date.now() - runStartedAt.current > 90000) { setTimedOut(true); setRunning(false); return; }
      } catch (error) { if (active) { setRunning(false); notify(error instanceof Error ? error.message : "No se pudo consultar la saga"); } }
    };
    poll(); const timer = window.setInterval(poll, 1000); return () => { active = false; window.clearInterval(timer); };
  }, [running, sagaState?.saga.saga_id, apiUrl]);
  useEffect(() => { if (chaos === "FONDOS_INSUFICIENTES" && originBalance) setAmount(Number(originBalance.saldo) + 1000); }, [chaos, originBalance]);

  const latestByStep = useMemo(() => Object.fromEntries(steps.map((step) => {
    const found = [...(sagaState?.pasos || [])].filter((item) => item.paso === step.id).sort((a, b) => new Date(a.actualizado_en).getTime() - new Date(b.actualizado_en).getTime()).at(-1);
    return [step.id, found?.estado || "PENDIENTE"];
  })) as Record<StepName, StepState>, [sagaState?.pasos]);
  const hasCompensation = sagaState?.pasos.some((step) => step.estado === "COMPENSANDO" || step.estado === "COMPENSADO");
  const startedAt = sagaState ? new Date(sagaState.saga.creado_en).getTime() : 0;
  const sortedSteps = [...(sagaState?.pasos || [])].sort((a, b) => new Date(a.actualizado_en).getTime() - new Date(b.actualizado_en).getTime());

  const submit = async (body: RequestBody, duplicate = false) => {
    setPreviousBalances({ origin: Number(originBalance?.saldo || 0), destination: Number(destinationBalance?.saldo || 0) });
    setRunning(!duplicate); setTimedOut(false); runStartedAt.current = Date.now();
    try {
      const response = await api<{ sagaId: string; duplicado?: boolean; mensaje?: string; estado?: string }>("/transferencias", { method: "POST", body: JSON.stringify(body) });
      if (response.duplicado) { setRunning(false); notify("Duplicado reconocido: no se ejecutó de nuevo", "success"); await loadBalances(); return; }
      setLastRequest(body); const next = await api<StateResponse>(`/transferencias/${response.sagaId}/estado`); setSagaState(next); notify("Saga iniciada. Observa cada paso en tiempo real.", "info");
    } catch (error) { setRunning(false); notify(error instanceof Error ? error.message : "No se pudo ejecutar la transferencia"); }
  };
  const execute = () => {
    if (!amount || amount <= 0 || !origin || !destination) { notify("Completa cuentas y usa un monto mayor que cero"); return; }
    void submit({ idempotencyKey: crypto.randomUUID(), modo: mode, cuentaOrigen: origin, cuentaDestino: destination, monto: Number(amount), escenarioSimulado: chaos });
  };
  const resend = () => { if (lastRequest && !running) void submit(lastRequest, true); };
  const reset = async () => {
    if (!window.confirm("¿Reiniciar los saldos de ORIGEN-001 y DESTINO-001?")) return;
    try { await api("/cuentas/reset", { method: "POST" }); setSagaState(null); setLastRequest(null); await loadBalances(); notify("Saldos reiniciados", "success"); } catch (error) { notify(error instanceof Error ? error.message : "No se pudieron reiniciar los saldos"); }
  };
  const saveUrl = () => { const next = draftUrl.trim().replace(/\/$/, ""); if (!next) return; localStorage.setItem("novabank_api_url", next); setApiUrl(next); setSettingsOpen(false); notify("URL del API guardada", "success"); };
  const copyAudit = async () => { await navigator.clipboard.writeText(JSON.stringify(sagaState?.pasos || [], null, 2)); notify("Bitácora copiada", "success"); };
  const link = mode === "ORQUESTADA" ? "http://localhost:4200" : "http://localhost:15672";

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-mark"><Zap size={18} /></div><div><p className="eyebrow">NOVA / OPERACIONES</p><h1>Simulador de Saga Bancaria</h1></div></div>
      <div className="top-actions">
        <span className={`connection-pill ${connected === true ? "is-online" : connected === false ? "is-offline" : "is-pending"}`}><span className="connection-dot" />{connected === true ? "Conectado" : connected === false ? "Sin conexión" : "Comprobando"}</span>
        <div className="settings-wrap"><button className="icon-button" title="Ajustes del API" onClick={() => setSettingsOpen(!settingsOpen)}><Settings size={18} /></button>{settingsOpen && <div className="settings-popover"><div className="popover-heading"><Settings size={16} /><span>Conexión del API</span></div><label>URL base<input value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveUrl()} /></label><button className="primary-button compact" onClick={saveUrl}>Guardar URL</button></div>}</div>
      </div>
    </header>

    <main className="workspace">
      <section className="hero-row"><div><p className="section-kicker">CONTROL ROOM <span>●</span> TRANSFERENCIAS DISTRIBUIDAS</p><h2>Prueba el viaje completo<br /><em>de una operación bancaria.</em></h2><p className="hero-copy">Lanza una transferencia, introduce fricción en cualquier frontera y observa cómo la saga protege el dinero.</p></div><div className="hero-stat"><span>ÚLTIMA SAGA</span><strong>{sagaState ? sagaState.saga.saga_id.slice(0, 8).toUpperCase() : "SIN EJECUCIÓN"}</strong><small>{sagaState ? formatTime(sagaState.saga.creado_en) : "Listo para iniciar"}</small></div></section>
      <div className="dashboard-grid">
        <aside className="control-panel panel">
          <div className="panel-heading"><div><p className="section-kicker">01 / CONFIGURACIÓN</p><h3>Preparar operación</h3></div><div className="panel-icon"><Gauge size={18} /></div></div>
          <div className="field-group"><label>Patrón de coordinación</label><div className="segmented"><button className={mode === "ORQUESTADA" ? "active" : ""} onClick={() => setMode("ORQUESTADA")}><GitBranch size={15} />Orquestada<span>Prefect</span></button><button className={mode === "COREOGRAFIADA" ? "active" : ""} onClick={() => setMode("COREOGRAFIADA")}><Zap size={15} />Coreografiada<span>RabbitMQ</span></button></div><p className="field-hint">{mode === "ORQUESTADA" ? "Un coordinador dirige cada paso y sus compensaciones." : "Cada servicio reacciona a eventos publicados en la cola."}</p></div>
          <div className="form-grid"><label>Cuenta origen<input value={origin} onChange={(event) => setOrigin(event.target.value)} disabled={running} /></label><label>Cuenta destino<input value={destination} onChange={(event) => setDestination(event.target.value)} disabled={running} /></label></div>
          <label className="amount-field">Monto a transferir<div className="amount-input"><span>$</span><input type="number" min="1" value={amount} onChange={(event) => setAmount(Number(event.target.value))} disabled={running} /><b>USD</b></div></label>
          <div className="chaos-block"><div className="chaos-heading"><div><p className="section-kicker">SIMULADOR DE CAOS</p><strong>Provocar un escenario</strong></div><ShieldAlert size={18} /></div><div className="chaos-options">
            {([ ["FONDOS_INSUFICIENTES", "Fondos insuficientes", "CP-02", WalletCards], ["FORZAR_RIESGO", "Fraude detectado", "CP-03", ShieldAlert], ["FORZAR_TIMEOUT_RED", "Timeout de pasarela", "CP-04", TimerReset] ] as const).map(([value, label, cp, Icon]) => <button className={`chaos-option ${chaos === value ? "selected" : ""}`} key={value} onClick={() => setChaos(chaos === value ? null : value)} disabled={running}><span className="chaos-icon"><Icon size={16} /></span><span>{label}<small>{cp}</small></span><span className="switch"><i /></span></button>)}
          </div></div>
          <button className="primary-button execute-button" onClick={execute} disabled={running}><Sparkles size={17} />{running ? "Saga en ejecución..." : "Ejecutar transferencia"}<ArrowRight size={17} /></button>
          <button className="secondary-button" onClick={resend} disabled={!lastRequest || running}><RotateCcw size={16} />Reenviar misma operación <span>CP-05</span></button>
          <button className="text-button" onClick={reset} disabled={running}><RefreshCw size={15} />Reiniciar saldos</button>
        </aside>

        <section className="monitor-column">
          <div className="balance-row"><BalanceCard label="Cuenta origen" account={origin} current={originBalance?.saldo} previous={previousBalances.origin} icon={ArrowUpRight} accent="cyan" /><BalanceCard label="Cuenta destino" account={destination} current={destinationBalance?.saldo} previous={previousBalances.destination} icon={ArrowDownLeft} accent="lime" /></div>
          <div className="panel timeline-panel"><div className="panel-heading"><div><p className="section-kicker">02 / RECORRIDO DE LA SAGA</p><h3>Línea de tiempo</h3></div><a className="external-link" href={link} target="_blank" rel="noreferrer">{mode === "ORQUESTADA" ? "Ver ejecución en Prefect" : "Ver colas en RabbitMQ"}<ExternalLink size={14} /></a></div><div className="timeline">
            {steps.map((step, index) => { const state = latestByStep[step.id]; const Icon = stateIcon[state]; return <div className="timeline-item" key={step.id}><div className={`step-card step-${state.toLowerCase()}`}><div className="step-top"><span>{step.id.replace("_", " · ")}</span><Icon className={state === "EN_EJECUCION" || state === "COMPENSANDO" ? "spin" : ""} size={18} /></div><strong>{step.title}</strong><small>{step.service}</small><Badge state={state} /></div>{index < steps.length - 1 && <div className="timeline-arrow"><ArrowRight size={15} /></div>}</div>; })}
          </div>{hasCompensation && <div className="compensation-line"><ArrowLeft size={17} /><span>Compensación en orden inverso</span><ArrowLeft size={17} /></div>}
          {timedOut && <div className="warning-banner"><AlertTriangle size={18} /><span>La saga no terminó: podría haber un paso en limbo.</span></div>}
          {sagaState?.saga.estado_final && <div className={`final-banner final-${sagaState.saga.estado_final.toLowerCase()}`}><div className="final-icon">{sagaState.saga.estado_final === "CONFIRMADO" ? <CheckCircle2 size={22} /> : <XCircle size={22} />}</div><div><span>ESTADO FINAL</span><strong>{sagaState.saga.estado_final.replaceAll("_", " ")}</strong><p>{finalCopy[sagaState.saga.estado_final] || "La saga terminó con un estado no catalogado."}</p></div></div>}</div>
          <div className="panel audit-panel"><div className="panel-heading"><div><p className="section-kicker">03 / TRAZA INMUTABLE</p><h3>Bitácora de auditoría</h3></div><button className="secondary-button small" onClick={copyAudit} disabled={!sagaState}><Copy size={14} />Copiar JSON</button></div>{sortedSteps.length ? <div className="audit-table-wrap"><table><thead><tr><th>Hora local</th><th>Δ desde inicio</th><th>Paso</th><th>Estado</th><th>Modo</th><th>Detalle</th></tr></thead><tbody>{sortedSteps.map((step) => { const detail = step.detalle; const delta = startedAt ? ((new Date(step.actualizado_en).getTime() - startedAt) / 1000).toFixed(1) : "—"; return <tr className={step.estado === "COMPENSANDO" || step.estado === "COMPENSADO" ? "is-compensation" : ""} key={step.id}><td className="mono">{formatTime(step.actualizado_en)}</td><td className="mono">+{delta}s</td><td><strong>{step.paso}</strong><small>{steps.find((item) => item.id === step.paso)?.title}</small></td><td><Badge state={step.estado} /></td><td><span className="mode-chip">{step.modo === "ORQUESTADA" ? "PREFECT" : "RABBITMQ"}</span></td><td><button className="detail-toggle" onClick={() => setExpanded(expanded === step.id ? null : step.id)}>{detail?.motivo || (detail?.datos ? Object.entries(detail.datos).map(([key, value]) => `${key}: ${value}`).join(" · ") : "Sin detalle")}{expanded === step.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>{expanded === step.id && <pre>{JSON.stringify(detail, null, 2)}</pre>}</td></tr>; })}</tbody></table></div> : <div className="empty-audit"><Terminal size={20} /><span>La bitácora aparecerá aquí al iniciar una saga.</span></div>}</div>
        </section>
      </div>
    </main>
    {toast && <div className={`toast toast-${toast.kind}`}><span>{toast.kind === "success" ? <CheckCircle2 size={17} /> : toast.kind === "info" ? <Clock3 size={17} /> : <AlertTriangle size={17} />}</span><p>{toast.message}</p><button onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}

function BalanceCard({ label, account, current, previous, icon: Icon, accent }: { label: string; account: string; current?: number; previous: number; icon: typeof ArrowUpRight; accent: string }) {
  const value = current ?? previous; const diff = value - previous;
  return <div className={`balance-card balance-${accent}`}><div className="balance-card-top"><span>{label}</span><span className="account-icon"><Icon size={17} /></span></div><strong>{current === undefined ? "—" : formatMoney(value)}</strong><div className="balance-meta"><span>{account}</span><span className={diff === 0 ? "neutral" : diff > 0 ? "positive" : "negative"}>{diff === 0 ? "Sin cambio" : `${formatDelta(diff)} vs. anterior`}</span></div></div>;
}

export default App;
