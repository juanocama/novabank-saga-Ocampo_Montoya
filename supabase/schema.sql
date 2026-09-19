-- =========================================================
-- NovaBank Saga - Schema de Supabase (Postgres)  -- versión corregida
-- Un esquema por microservicio (database-per-service) dentro de un
-- solo proyecto. Ejecutar COMPLETO en el SQL Editor de Supabase.
--
-- Es re-ejecutable: sirve tanto para una instalación nueva como
-- para una que ya corrió la primera versión, sin perder datos.
--
-- IMPORTANTE (paso manual, no se puede hacer desde este script):
--   Supabase > Settings > API > Data API > "Exposed schemas"
--   agregar:  cuentas, riesgo, pasarela, auditoria
-- =========================================================

-- ---------- Esquema: cuentas (Account & Ledger) ----------
create schema if not exists cuentas;

create table if not exists cuentas.cuentas_bancarias (
  numero_cuenta text primary key,
  saldo numeric(14,2) not null default 0,
  actualizado_en timestamptz not null default now()
);

create table if not exists cuentas.movimientos (
  id uuid primary key default gen_random_uuid(),
  saga_id uuid not null,
  numero_cuenta text not null references cuentas.cuentas_bancarias(numero_cuenta),
  tipo text not null check (tipo in ('DEBITO', 'CREDITO', 'REVERSA_DEBITO', 'REVERSA_CREDITO')),
  monto numeric(14,2) not null,
  idempotency_key text not null,
  creado_en timestamptz not null default now(),
  unique (idempotency_key, tipo)
);

-- Datos de ejemplo para poder probar de inmediato
insert into cuentas.cuentas_bancarias (numero_cuenta, saldo) values
  ('ORIGEN-001', 5000.00),
  ('DESTINO-001', 1000.00)
on conflict (numero_cuenta) do nothing;

-- ---------- Esquema: riesgo (Risk & Fraud) ----------
create schema if not exists riesgo;

create table if not exists riesgo.evaluaciones (
  id uuid primary key default gen_random_uuid(),
  saga_id uuid not null,
  numero_cuenta text not null,
  monto numeric(14,2) not null,
  aprobado boolean not null,
  motivo text,
  idempotency_key text not null unique,
  creado_en timestamptz not null default now()
);

-- ---------- Esquema: pasarela (Clearing Gateway) ----------
create schema if not exists pasarela;

create table if not exists pasarela.liquidaciones (
  id uuid primary key default gen_random_uuid(),
  saga_id uuid not null,
  monto numeric(14,2) not null,
  estado text not null check (estado in ('LIQUIDADO', 'FALLIDO', 'ANULADO')),
  idempotency_key text not null unique,
  creado_en timestamptz not null default now()
);

-- ---------- Esquema: auditoria (estado de la Saga, leído por el frontend) ----------
create schema if not exists auditoria;

create table if not exists auditoria.pasos_saga (
  id uuid primary key default gen_random_uuid(),
  saga_id uuid not null,
  paso text not null,               -- S1_DEBITO, S2_RIESGO, S3_LIQUIDACION, S4_CREDITO
  modo text not null check (modo in ('ORQUESTADA', 'COREOGRAFIADA')),
  estado text not null check (estado in
    ('PENDIENTE','EN_EJECUCION','EXITOSO','FALLIDO','COMPENSANDO','COMPENSADO')),
  detalle jsonb,
  actualizado_en timestamptz not null default now()
);

create table if not exists auditoria.sagas (
  saga_id uuid primary key,
  modo text not null check (modo in ('ORQUESTADA', 'COREOGRAFIADA')),
  cuenta_origen text not null,
  cuenta_destino text not null,
  monto numeric(14,2) not null,
  escenario_simulado text, -- null | FONDOS_INSUFICIENTES | FORZAR_RIESGO | FORZAR_TIMEOUT_RED | REINTENTO
  estado_final text,       -- ver constraint más abajo
  creado_en timestamptz not null default now()
);

-- Índice usado por el polling del frontend (trae los pasos de una saga en orden)
create index if not exists idx_pasos_saga_saga_id on auditoria.pasos_saga (saga_id, actualizado_en);

-- ---------- Migraciones para instalaciones previas (no-op si ya está al día) ----------
-- La primera versión usaba uuid; el código guarda llaves tipo '<sagaId>:S1_DEBITO'.
alter table cuentas.movimientos    alter column idempotency_key type text using idempotency_key::text;
alter table riesgo.evaluaciones    alter column idempotency_key type text using idempotency_key::text;
alter table pasarela.liquidaciones alter column idempotency_key type text using idempotency_key::text;

-- Estados finales válidos de una saga (se recrea para que funcione en ambos casos).
alter table auditoria.sagas drop constraint if exists sagas_estado_final_check;
alter table auditoria.sagas add constraint sagas_estado_final_check check (estado_final in
  ('CONFIRMADO','RECHAZADO_FONDOS','RECHAZADO_DESTINO','RECHAZADO_RIESGO','RECHAZADO_RED'));

-- ---------- Movimiento atómico e idempotente ----------
-- Bloquea la fila de la cuenta (FOR UPDATE), valida y actualiza el saldo y
-- registra el movimiento en UNA sola transacción. Devuelve (estado, saldo, motivo):
--   estado = EXITOSO | DUPLICADO | FALLIDO
--   motivo = FONDOS_INSUFICIENTES | CUENTA_NO_EXISTE | MONTO_INVALIDO | TIPO_INVALIDO | null
create or replace function cuentas.aplicar_movimiento(
  p_saga_id uuid,
  p_numero_cuenta text,
  p_tipo text,
  p_monto numeric,
  p_idempotency_key text
) returns table (estado text, saldo numeric, motivo text)
language plpgsql
security definer
set search_path = cuentas, pg_temp
as $$
#variable_conflict use_column
declare
  v_cuenta cuentas.cuentas_bancarias%rowtype;
  v_delta  numeric;
  v_monto  numeric := round(p_monto, 2);
begin
  if p_tipo is null or p_tipo not in ('DEBITO','CREDITO','REVERSA_DEBITO','REVERSA_CREDITO') then
    return query select 'FALLIDO'::text, null::numeric, 'TIPO_INVALIDO'::text;
    return;
  end if;

  -- Un monto <= 0 permitiría "fabricar" dinero (débito negativo = crédito).
  if v_monto is null or v_monto <= 0 then
    return query select 'FALLIDO'::text, null::numeric, 'MONTO_INVALIDO'::text;
    return;
  end if;

  -- Idempotencia: si esta operación ya se aplicó, no se repite.
  if exists (
    select 1 from cuentas.movimientos m
    where m.idempotency_key = p_idempotency_key and m.tipo = p_tipo
  ) then
    return query select 'DUPLICADO'::text,
      (select c.saldo from cuentas.cuentas_bancarias c where c.numero_cuenta = p_numero_cuenta),
      null::text;
    return;
  end if;

  select * into v_cuenta from cuentas.cuentas_bancarias c
    where c.numero_cuenta = p_numero_cuenta
    for update;
  if not found then
    return query select 'FALLIDO'::text, null::numeric, 'CUENTA_NO_EXISTE'::text;
    return;
  end if;

  v_delta := case when p_tipo in ('DEBITO','REVERSA_CREDITO') then -v_monto else v_monto end;

  if v_delta < 0 and v_cuenta.saldo < v_monto then
    return query select 'FALLIDO'::text, v_cuenta.saldo, 'FONDOS_INSUFICIENTES'::text;
    return;
  end if;

  update cuentas.cuentas_bancarias c
    set saldo = v_cuenta.saldo + v_delta, actualizado_en = now()
    where c.numero_cuenta = p_numero_cuenta;

  insert into cuentas.movimientos (saga_id, numero_cuenta, tipo, monto, idempotency_key)
    values (p_saga_id, p_numero_cuenta, p_tipo, v_monto, p_idempotency_key);

  return query select 'EXITOSO'::text, v_cuenta.saldo + v_delta, null::text;

exception when unique_violation then
  -- Dos llamadas simultáneas con la misma llave: la segunda cae aquí y su
  -- actualización de saldo se revierte automáticamente (subtransacción).
  return query select 'DUPLICADO'::text,
    (select c.saldo from cuentas.cuentas_bancarias c where c.numero_cuenta = p_numero_cuenta),
    null::text;
end;
$$;

-- ---------- Seguridad: solo el backend (service_role) toca estos esquemas ----------
-- RLS activado y sin políticas: anon/authenticated no ven nada.
-- service_role ignora RLS, así que los microservicios siguen funcionando.
alter table cuentas.cuentas_bancarias enable row level security;
alter table cuentas.movimientos       enable row level security;
alter table riesgo.evaluaciones       enable row level security;
alter table pasarela.liquidaciones    enable row level security;
alter table auditoria.pasos_saga      enable row level security;
alter table auditoria.sagas           enable row level security;

-- La función mueve dinero: nadie salvo service_role puede ejecutarla.
revoke all on function cuentas.aplicar_movimiento(uuid, text, text, numeric, text)
  from public, anon, authenticated;

-- ---------- Permisos para service_role (usado por los microservicios) ----------
grant usage on schema cuentas, riesgo, pasarela, auditoria to service_role;
grant all privileges on all tables    in schema cuentas, riesgo, pasarela, auditoria to service_role;
grant all privileges on all sequences in schema cuentas, riesgo, pasarela, auditoria to service_role;
grant execute on function cuentas.aplicar_movimiento(uuid, text, text, numeric, text) to service_role;

-- Objetos que se creen en el futuro en estos esquemas.
-- Ojo: es "in schema" (singular) aunque reciba varios esquemas.
alter default privileges in schema cuentas, riesgo, pasarela, auditoria
  grant all on tables to service_role;
alter default privileges in schema cuentas, riesgo, pasarela, auditoria
  grant all on sequences to service_role;
alter default privileges in schema cuentas, riesgo, pasarela, auditoria
  grant execute on functions to service_role;

-- Pide a la API REST de Supabase que recargue el catálogo (tablas y función nuevas).
notify pgrst, 'reload schema';

