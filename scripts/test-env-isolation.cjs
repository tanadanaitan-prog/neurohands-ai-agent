// Preloaded into the node --test process so tests never inherit production
// tuning variables (Railway exposes service variables during the build).
const SCRUBBED = [
  "GEMINI_MODELS",
  "GEMINI_FALLBACK_MODELS",
  "MODEL_TIMEOUT_MS",
  "SUPABASE_TIMEOUT_MS",
  "PROVIDER_FAILURE_TTL_MS",
];
for (const name of SCRUBBED) delete process.env[name];
