export interface CodexUsageWindow {
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: number | null;
}

export interface CodexCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: number | null;
}

export interface CodexLastUsage {
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
  credits?: CodexCredits;
  plan_type?: string | null;
}

export interface CodexRegistryAccount {
  email: string;
  alias?: string;
  plan?: string | null;
  auth_mode?: string;
  created_at?: number | null;
  last_used_at?: number | null;
  last_usage?: CodexLastUsage;
  last_usage_at?: number | null;
}

export interface CodexRegistry {
  version: number;
  active_email?: string | null;
  accounts: CodexRegistryAccount[];
}

export interface CodexAuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexAuthTokens;
  last_refresh?: string | null;
}

export interface ManagedAccount {
  id: string;
  name: string;
  codex_home: string;
  email?: string;
  enabled: boolean;
  imported_at?: string;
}

export interface CslotConfig {
  version: number;
  server: {
    host: string;
    port: number;
    api_key: string;
    body_limit_mb: number;
  };
  upstream: {
    codex_base_url: string;
    auth_base_url: string;
    oauth_client_id: string;
  };
  accounts: ManagedAccount[];
}

export interface AccountRuntimeStatus {
  id: string;
  name: string;
  email?: string;
  enabled: boolean;
  exists: boolean;
  plan: string;
  fiveHourLeftPercent: number | null;
  fiveHourResetsAt: number | null;
  weeklyLeftPercent: number | null;
  weeklyResetsAt: number | null;
  isFiveHourLimited: boolean;
  isWeeklyLimited: boolean;
  localBlockReason?: string;
  localBlockUntil?: number | null;
  refreshErrorCode?: string | null;
  refreshErrorMessage?: string | null;
  isAvailable: boolean;
  sourcePath: string;
}

export interface SchedulerPick {
  account: ManagedAccount;
  status: AccountRuntimeStatus;
  reason: string;
}

export interface RunOptions {
  codexArgs: string[];
  dryRun?: boolean;
}

export interface UsageRefreshResult {
  accountId: string;
  email?: string;
  plan: string;
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: number | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: number | null;
  refreshedAt: string;
}

export interface UsageRefreshError {
  accountId: string;
  code: string;
  message: string;
  updatedAt: string;
}

export interface AccountBlockState {
  until: number | null;
  reason: string;
  updated_at: string;
}

export interface AccountSchedulerStats {
  success_count: number;
  last_success_at: string | null;
}

export interface ManagedCodexConfigState {
  target_file: string;
  original_model_provider_block: string | null;
  original_model_provider_next_table_header?: string | null;
  original_cslot_provider_block: string | null;
  original_cslot_provider_previous_table_header?: string | null;
  original_cslot_provider_next_table_header?: string | null;
}

export interface ManagedCodexAuthState {
  target_home: string;
  source_account_id?: string | null;
  original_auth_file: string | null;
  original_registry_file: string | null;
  original_account_auth_files: Record<string, string>;
}

export interface CslotState {
  account_blocks: Record<string, AccountBlockState>;
  usage_cache: Record<string, UsageRefreshResult>;
  usage_refresh_errors: Record<string, UsageRefreshError>;
  scheduler_stats: Record<string, AccountSchedulerStats>;
  managed_codex_auth?: ManagedCodexAuthState | null;
  managed_codex_config?: ManagedCodexConfigState | null;
}
