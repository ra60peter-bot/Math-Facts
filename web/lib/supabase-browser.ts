import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function hasSupabaseConfig() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function supabaseBrowser() {
  if (!hasSupabaseConfig()) return null;
  if (!client) {
    // Migrate away from owner credentials persisted on a shared student device.
    if(typeof window!=="undefined")localStorage.removeItem("math-facts-auth");
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "math-facts-auth",
        },
      },
    );
  }
  return client;
}
