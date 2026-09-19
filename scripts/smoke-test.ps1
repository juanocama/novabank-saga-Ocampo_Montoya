$ErrorActionPreference = 'Stop'

$Gateway = if ($env:NOVABANK_GATEWAY_URL) { $env:NOVABANK_GATEWAY_URL } else { 'http://localhost:3000' }
$PollSeconds = 2
$TimeoutSeconds = 90
$InitialOrigin = 5000
$InitialDestination = 1000

function Invoke-Json {
    param(
        [string]$Method,
        [string]$Uri,
        [object]$Body = $null
    )
    $params = @{ Method = $Method; Uri = $Uri; ContentType = 'application/json' }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    Invoke-RestMethod @params
}

function Get-Saldo([string]$Account) {
    (Invoke-Json 'GET' "$Gateway/cuentas/$Account/saldo").saldo
}

function Wait-Saga([string]$SagaId) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $state = Invoke-Json 'GET' "$Gateway/transferencias/$SagaId/estado"
        if ($state.saga.estado_final) { return $state }
        Start-Sleep -Seconds $PollSeconds
    } while ((Get-Date) -lt $deadline)
    throw "Timeout esperando saga $SagaId"
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ([decimal]$Actual -ne [decimal]$Expected) { throw "${Label}: esperado $Expected, recibido $Actual" }
}

function Assert-CompensationOrder($Steps, [string]$Mode, [string]$Scenario) {
    if ($Scenario -notin @('CP-03', 'CP-04')) { return }
    $compensating = @($Steps | Where-Object { $_.estado -eq 'COMPENSANDO' })
    if ($Mode -eq 'COREOGRAFIADA') {
        $expected = if ($Scenario -eq 'CP-03') { @('S1_DEBITO') } else { @('S2_RIESGO', 'S1_DEBITO') }
    } else {
        $expected = if ($Scenario -eq 'CP-03') { @('S1_DEBITO') } else { @('S2_RIESGO', 'S1_DEBITO') }
    }
    $actual = @($compensating | ForEach-Object { $_.paso })
    if (($actual -join ',') -ne ($expected -join ',')) {
        throw "orden de compensacion incorrecto: esperado $($expected -join ' -> '), recibido $($actual -join ' -> ')"
    }
}

function Assert-StepState($Steps, [string]$Step, [string]$Expected) {
    $latest = @($Steps | Where-Object paso -eq $Step | Sort-Object actualizado_en | Select-Object -Last 1)
    if ($latest.Count -eq 0 -or $latest[0].estado -ne $Expected) {
        throw "estado de $Step esperado $Expected"
    }
}

$cases = @(
    @{ Name = 'CP-01'; Expected = 'CONFIRMADO'; Amount = 500; Scenario = $null; Origin = 4500; Destination = 1500 },
    @{ Name = 'CP-02'; Expected = 'RECHAZADO_FONDOS'; Amount = 6000; Scenario = $null; Origin = 5000; Destination = 1000 },
    @{ Name = 'CP-03'; Expected = 'RECHAZADO_RIESGO'; Amount = 500; Scenario = 'FORZAR_RIESGO'; Origin = 5000; Destination = 1000 },
    @{ Name = 'CP-04'; Expected = 'RECHAZADO_RED'; Amount = 500; Scenario = 'FORZAR_TIMEOUT_RED'; Origin = 5000; Destination = 1000 },
    @{ Name = 'CP-05'; Expected = 'CONFIRMADO'; Amount = 500; Scenario = $null; Origin = 4500; Destination = 1500 }
)

$results = @()
foreach ($mode in @('COREOGRAFIADA', 'ORQUESTADA')) {
    foreach ($case in $cases) {
        $label = "$($case.Name)-$mode"
        try {
            Invoke-Json 'POST' "$Gateway/cuentas/reset" | Out-Null
            $key = [guid]::NewGuid().ToString()
            $body = @{
                idempotencyKey = $key
                modo = $mode
                cuentaOrigen = 'ORIGEN-001'
                cuentaDestino = 'DESTINO-001'
                monto = $case.Amount
            }
            if ($null -ne $case.Scenario) { $body.escenarioSimulado = $case.Scenario }
            $start = Invoke-Json 'POST' "$Gateway/transferencias" $body
            $state = Wait-Saga $start.sagaId

            if ($state.saga.estado_final -ne $case.Expected) {
                throw "estado_final esperado $($case.Expected), recibido $($state.saga.estado_final)"
            }
            Assert-Equal (Get-Saldo 'ORIGEN-001') $case.Origin 'saldo origen'
            Assert-Equal (Get-Saldo 'DESTINO-001') $case.Destination 'saldo destino'
            Assert-CompensationOrder $state.pasos $mode $case.Name

            if ($case.Name -eq 'CP-05') {
                $duplicate = Invoke-Json 'POST' "$Gateway/transferencias" $body
                if (-not $duplicate.duplicado) { throw 'reenvio CP-05 no fue marcado como duplicado' }
                Assert-Equal (Get-Saldo 'ORIGEN-001') $case.Origin 'saldo origen tras duplicado'
                Assert-Equal (Get-Saldo 'DESTINO-001') $case.Destination 'saldo destino tras duplicado'
            }
            $results += [pscustomobject]@{ Caso = $case.Name; Modo = $mode; Resultado = 'PASS'; Detalle = $state.saga.estado_final }
        } catch {
            $results += [pscustomobject]@{ Caso = $case.Name; Modo = $mode; Resultado = 'FAIL'; Detalle = $_.Exception.Message }
        }
    }
}

$results | Format-Table -AutoSize

try {
    Invoke-Json 'POST' "$Gateway/cuentas/reset" | Out-Null
    docker compose stop clearing-service | Out-Null
    try {
        $body = @{ idempotencyKey = [guid]::NewGuid().ToString(); modo = 'ORQUESTADA'; cuentaOrigen = 'ORIGEN-001'; cuentaDestino = 'DESTINO-001'; monto = 500; escenarioSimulado = $null }
        $start = Invoke-Json 'POST' "$Gateway/transferencias" $body
        $state = Wait-Saga $start.sagaId
        Assert-Equal (Get-Saldo 'ORIGEN-001') 5000 'T1 saldo origen'
        Assert-Equal (Get-Saldo 'DESTINO-001') 1000 'T1 saldo destino'
        Assert-StepState $state.pasos 'S2_RIESGO' 'COMPENSADO'
        Assert-StepState $state.pasos 'S1_DEBITO' 'COMPENSADO'
        if ($state.saga.estado_final -ne 'RECHAZADO_RED') { throw "T1 estado esperado RECHAZADO_RED" }
        $results += [pscustomobject]@{ Caso = 'T1'; Modo = 'ORQUESTADA'; Resultado = 'PASS'; Detalle = 'RECHAZADO_RED + compensación S2/S1' }
    } finally {
        docker compose start clearing-service | Out-Null
    }
} catch {
    $results += [pscustomobject]@{ Caso = 'T1'; Modo = 'ORQUESTADA'; Resultado = 'FAIL'; Detalle = $_.Exception.Message }
}

try {
    Invoke-Json 'POST' "$Gateway/cuentas/reset" | Out-Null
    docker compose stop clearing-service | Out-Null
    $body = @{ idempotencyKey = [guid]::NewGuid().ToString(); modo = 'COREOGRAFIADA'; cuentaOrigen = 'ORIGEN-001'; cuentaDestino = 'DESTINO-001'; monto = 500; escenarioSimulado = $null }
    $start = Invoke-Json 'POST' "$Gateway/transferencias" $body
    Start-Sleep -Seconds 4
    docker compose start clearing-service | Out-Null
    $state = Wait-Saga $start.sagaId
    Assert-Equal (Get-Saldo 'ORIGEN-001') 4500 'T2 saldo origen'
    Assert-Equal (Get-Saldo 'DESTINO-001') 1500 'T2 saldo destino'
    if ($state.saga.estado_final -ne 'CONFIRMADO') { throw "T2 estado esperado CONFIRMADO" }
    $results += [pscustomobject]@{ Caso = 'T2'; Modo = 'COREOGRAFIADA'; Resultado = 'PASS'; Detalle = 'mensaje durable confirmado tras reinicio' }
} catch {
    docker compose start clearing-service | Out-Null
    $results += [pscustomobject]@{ Caso = 'T2'; Modo = 'COREOGRAFIADA'; Resultado = 'FAIL'; Detalle = $_.Exception.Message }
}

try {
    Invoke-Json 'POST' "$Gateway/cuentas/reset" | Out-Null
    $before = Get-Saldo 'ORIGEN-001'
    $probeId = [guid]::NewGuid().ToString()
    $compensation = Invoke-Json 'POST' 'http://localhost:3001/debitar/compensar' @{ sagaId = $probeId; cuentaOrigen = 'ORIGEN-001'; monto = 500 }
    $after = Get-Saldo 'ORIGEN-001'
    Assert-Equal $after $before 'T3 saldo origen'
    if ($compensation.estado -ne 'FALLIDO' -or $compensation.motivo -ne 'DEBITO_ORIGINAL_NO_EXISTE') { throw 'T3 no devolvió DEBITO_ORIGINAL_NO_EXISTE' }
    $results += [pscustomobject]@{ Caso = 'T3'; Modo = 'ACCOUNT'; Resultado = 'PASS'; Detalle = 'sin débito original, saldo intacto' }
} catch {
    $results += [pscustomobject]@{ Caso = 'T3'; Modo = 'ACCOUNT'; Resultado = 'FAIL'; Detalle = $_.Exception.Message }
}

Write-Host "`nResultados completos"
$results | Format-Table -AutoSize
if (@($results | Where-Object Resultado -eq 'FAIL').Count -gt 0) { exit 1 }
