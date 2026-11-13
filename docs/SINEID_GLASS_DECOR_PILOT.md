# Sineid Glass Decor LINE pilot

## Current state

This is a prepared, inactive onboarding profile. It does not connect to or
change any LINE Official Account, Railway service, or Supabase project.

The business name **Sineid Glass Decor** came from the owner request. Searches
on 2026-09-18 did not locate an exact, verifiable public business listing under
that name. The profile therefore contains no assumed description, services,
prices, address, hours, policies, or contact details. The owner must provide an
official page or approved business information before customer replies can be
enabled.

The machine-readable draft is
[`config/business-profiles/sineid-glass-decor.v1.json`](../config/business-profiles/sineid-glass-decor.v1.json).
Secrets must stay in the dedicated Railway service and must never be written to
that file or committed to Git.

## Isolation decision

Use a dedicated Railway service and a dedicated Supabase project for this
pilot, while reusing the reviewed Neurohands source code.

The current Phase 1 runtime has one global LINE channel secret, one global LINE
access token, global company settings, and global product and edging tables.
Pointing a second, unrelated business at the existing service or database can
cause signature failures, replies from the wrong OA, or business-data mixing.
A shared multi-business deployment requires a later channel and data-scope
refactor plus cross-business isolation tests.

## $0 test limits

This design can fit the published free-plan shape only as a small test, subject
to the owner's current account usage:

- Supabase currently permits two active Free projects across organizations
  where the user is an Owner or Administrator. Each Free project includes a
  500 MB database and 1 GB file storage, has a 50 MB maximum file upload, and
  may pause after a week of low activity.
- Railway currently permits one Free project with up to three services and
  supplies $1 of monthly resource credit after the trial. A second service can
  fit the service-count limit, but two continuously running services may exceed
  that credit and stop. A $0 setup therefore cannot guarantee continuous 24/7
  availability.

Before creating anything, verify the dashboard's current project count, plan,
credit, and estimated usage. Do not add billing or raise a spending limit.

Official references:

- [Supabase pricing](https://supabase.com/pricing)
- [Supabase billing and Free project limit](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Railway Free Trial](https://docs.railway.com/pricing/free-trial)
- [Railway plans and resource limits](https://docs.railway.com/pricing/plans)

## Activation gates

All gates must pass before automatic customer replies are enabled:

1. The owner confirms the exact official business name and supplies at least
   one official source or an approved business-information document.
2. Services, prices, hours, location, contacts, quotation rules, and escalation
   contacts are reviewed. Unknown items remain blank.
3. The Sineid LINE OA is enabled for Messaging API under the intended provider.
   Channel ID and OA ID are recorded; the channel secret and access token are
   entered privately in the Sineid Railway service.
4. A separate Supabase project is created, the reviewed migrations are applied,
   and only Sineid test data is loaded. The server-only secret stays in Railway.
5. A separate Railway service is created from the accepted repository commit.
   Its generated HTTPS domain becomes the Sineid webhook URL with `/webhook`.
6. LINE's **Verify** action succeeds, **Use webhook** is on, and the OA's own
   automatic greeting/response settings do not compete with the agent.
7. Synthetic tests pass for verified company questions, unknown questions,
   prompt injection, missing prices, human escalation, duplicate webhook
   delivery, model failure, and cross-business data requests.
8. A human reviews the first live test conversations. Automatic replies remain
   limited to the verified facts and approved actions.

## Reply flow

```text
Sineid customer
  -> Sineid LINE OA
  -> Sineid-only Railway /webhook
  -> signature and duplicate-event checks
  -> Sineid-only Supabase facts and conversation evidence
  -> model drafts an answer from verified facts
  -> policy and tool-result checks
  -> reply, or human handoff when evidence is missing
  -> monitor delivery, latency, failures, and escalations
```

## Required owner-supplied fields

Leave these blank until the owner verifies them:

- official website, Facebook page, LINE OA page, or approved company profile;
- legal and trading names;
- services and product catalogue;
- current prices or rules for requesting a quotation;
- business hours, service area, address, and contact methods;
- return, warranty, cancellation, privacy, and escalation policies;
- Sineid LINE provider, channel, and OA identifiers;
- human escalation recipient and expected response time.

Do not paste channel secrets, access tokens, database secrets, or model API keys
into GitHub, documentation, or chat. Enter them only in the Sineid Railway
service's private Variables page.

## First acceptance test

Use a separate personal LINE account. Send these messages and save the question,
answer, source used, latency, and outcome:

1. a company question that has a verified source;
2. a service question that has a verified source;
3. a price question when no approved price exists;
4. an unrelated or ambiguous question;
5. a request to reveal another company's information;
6. the same message delivered twice;
7. a request for a human.

The pilot passes only when supported answers match approved sources, unsupported
answers clearly defer, no other business data appears, duplicate delivery does
not repeat work, and human handoff is recorded.
