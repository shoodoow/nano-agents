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
