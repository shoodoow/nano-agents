# Security Policy

## Supported versions

`main` is the only supported branch. Use the latest commit.

## Reporting a vulnerability

Do not open a public issue. Use [GitHub private security advisories](https://github.com/shoodoow/nano-agents/security/advisories/new)
for this repository and include:

- affected commit / version
- reproduction steps or proof of concept
- impact assessment

Expect an initial response within 72 hours. We will coordinate a fix and
disclosure timeline with you.

## What the software protects, and what it does not

- **Accounts.** Every API route checks the signed-in session against the
  account in the request. Model keys, plugin tokens and vault secrets are
  sealed in Postgres with a key derived from `BETTER_AUTH_SECRET`.
- **Requests the core makes for you.** Plugin sign-in fetches go only to
  public internet addresses; the address is checked when the connection is
  made, not just by name.
- **Agent computers.** Each account has one Linux container. Agents on the
  same account share it and have administrator rights inside it, so they are
  not isolated from each other, and plugin access tokens placed in the
  container are readable by them. The container itself is a standard Docker
  container on the default network: treat it as a convenience boundary, not a
  hardened sandbox, until a stronger runtime is in place.
- **Auto-review.** Approval cards catch common destructive commands so a
  model's mistake waits for a person. It is a pattern list and can be worked
  around; it is not a security control against a hostile agent.

## Secrets hygiene

- Never commit `.env`, OAuth client secrets, `BETTER_AUTH_SECRET`, API keys,
  tunnel credentials, or Expo tokens.
- `.env.example` files must contain placeholders only (`api.example.com`,
  empty secrets).
- If you accidentally commit a secret: rotate it immediately (Google Cloud,
  Better Auth secret, Exa/Brave keys), then purge it from history
  (`git-filter-repo` / BFG) before pushing anywhere public.
- Production requires `NODE_ENV=production`, unique secrets per environment,
  HTTPS-only OAuth redirect URIs, and Postgres not exposed publicly.
  See `deploy/SETUP.md#security-checklist`.
