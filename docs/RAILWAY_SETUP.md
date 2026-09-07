# Destination Railway setup

Observed 2026-09-07. The new **Neurohands AI Agent** project is in the destination account's **Neurohands's Projects** workspace. It is separate from the unidentified original `neurohands-bot` deployment. No original deployment has been retired or LINE webhook switched.

- Project: `9a97651f-2fdf-4537-bce4-d6a7ad877720`
- Production environment: `d41441ac-3e12-4676-b989-ec9da8c10ec5`
- Service: `7a41f9eb-e772-4a63-86ba-89cdfd608386`, `neurohands-ai-agent`
- Source: `tanadanaitan-prog/neurohands-ai-agent`, branch `main`, repository root.
- [Service variables](https://railway.com/project/9a97651f-2fdf-4537-bce4-d6a7ad877720/service/7a41f9eb-e772-4a63-86ba-89cdfd608386/variables?environmentId=d41441ac-3e12-4676-b989-ec9da8c10ec5).

## Staged configuration, not a live deployment

| Setting | Value |
| --- | --- |
| Builder | Railpack |
| Build command | `npm run check && npm test && npm run build` |
| Start command | `npm start` |
| Healthcheck | `/ready` |
| Healthcheck timeout | 60 seconds |
| Restart | On failure, maximum 3 retries |
| Replicas | 1 |
| Serverless | Disabled; the inbox worker must poll pending work |
| Public domain | Requested; generated on deployment |

The service settings and four non-secret defaults (`SUPABASE_URL`, `ENABLE_STUDIO=false`, `GEMINI_MODEL`, `FALLBACK_PROVIDER`) were staged in Railway. The provider/model defaults came from the user's previous screenshots and do not establish current model availability. Secrets remain missing. The staged Deploy action has not been submitted, and no healthy runtime or public endpoint is claimed.

Railway has deprecated `railway.json`/`railway.toml` Config as Code for new services. The included legacy file is retained as a reference; the new service is configured directly in its dashboard. Existing users of that file format have a 2026-12-01 cutoff. A later Infrastructure as Code migration can record the same settings after the pilot is proven. [Railway documentation](https://docs.railway.com/config-as-code).

## Finish configuration

Enter values privately in Railway. Never put them in Git, screenshots or chat:

- `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` from the intended LINE channel.
- `SUPABASE_SERVICE_KEY` for project `darxiaearohhnxiwhcbs`; use a server-only secret.
- `FOUNDER_LINE_ID` for the authorized operator.
- `GEMINI_API_KEY` and a supported `GEMINI_MODEL`, or `FALLBACK_API_KEY` with a supported provider/model configuration.
- A random private `NEUROHANDS_API_KEY` for the backend endpoint.
- A separate random 32-byte base64 `WEBHOOK_ENCRYPTION_KEY`; preserve it across restarts and deployments.

Leave optional `JARVIS_ACTIVATION_CODE` and `CRON_SECRET` blank until those paths are needed. `ENABLE_STUDIO` remains false. Supabase publishable keys and Auth setup belong to the later website milestone. Railway supplies `PORT`; use its generated public domain for upload links or set `PUBLIC_URL` explicitly.

After variables are saved, review staged changes, deploy, inspect build/runtime logs, then check `/ready` and `/version` against the intended Git commit. Verify the intended LINE channel before changing its webhook URL. Run the real KNC document proof and negative access/failure cases from `PHASE1_STATUS.md`; a successful healthcheck alone is insufficient. Follow `WEBHOOK_RECOVERY.md` for pending or uncertain events.

## Remaining ownership work

The visible Railway account signs in through destination GitHub user `tanadanaitan-prog`; its Railway email field was empty. Creating this project does not establish that the original service's variables, domains, scheduled jobs or history were transferred. Reconcile those resources before removing the former account's access. The workspace currently has trial limits; no plan upgrade or payment was performed.
