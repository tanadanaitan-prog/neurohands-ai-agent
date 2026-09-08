-- Nullable preserves unknown usage for historical or interrupted runs.
-- Inherits agent_runs RLS and service-role-only grants; no new API grants.
alter table public.agent_runs add column llm_metrics jsonb
  check (llm_metrics is null or jsonb_typeof(llm_metrics) = 'object');
comment on column public.agent_runs.llm_metrics is
  'Versioned per-run model attempts, provider-reported token usage and timings. NULL means unavailable, never zero. No prompts, response text, keys or inferred cost.';
