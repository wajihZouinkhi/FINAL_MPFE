import { Injectable } from "@nestjs/common";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { AppConfigService } from "../config/app-config.service";

/**
 * Server-side Supabase client. Uses the service-role key — bypasses RLS.
 * Safe because (a) MVP has RLS off and (b) this client never reaches the
 * browser. The frontend uses the anon key.
 */
@Injectable()
export class SupabaseService {
  readonly client: SupabaseClient;

  constructor(cfg: AppConfigService) {
    this.client = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
}
