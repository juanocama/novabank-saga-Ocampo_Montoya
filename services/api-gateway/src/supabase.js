import { createClient } from "@supabase/supabase-js";
import ws from "ws";

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { db: { schema: "auditoria" }, realtime: { transport: ws } }
);

export const cuentasDb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { db: { schema: "cuentas" }, realtime: { transport: ws } }
);
