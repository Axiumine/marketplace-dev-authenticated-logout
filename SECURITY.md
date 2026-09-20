# Security policy

## Reporting a vulnerability

Report privately. Do not open a public issue, and do not describe the problem in a pull
request.

- **Preferred** — GitHub private vulnerability reporting: open the repository's
  **Security** tab and choose *Report a vulnerability*. The report stays private to the
  maintainers until an advisory is published.
- **Email** — `dev@giovannimanzoni.com`, the address already published as the maintainer
  contact in this platform's package metadata. Encrypt if you can; if you cannot, send the
  minimum needed to reproduce and nothing more.

Please include the affected repository and commit, what an attacker gains, and the steps
or request that reproduce it.

## What to expect

| Stage | Target |
|---|---|
| acknowledgement of your report | 3 working days |
| first assessment, with a severity | 10 working days |
| fix or documented mitigation for a confirmed HIGH or CRITICAL issue | 30 days |
| coordinated public disclosure | after the fix ships, by agreement with you |

Coordinated disclosure: findings are published as a GitHub Security Advisory once a fix is
available, crediting you unless you ask otherwise. If a report is declined, you are told
why and are free to disclose it yourself.

## Scope

This repository is one of sixteen that make up the marketplace platform. A finding that
crosses repositories only needs one report — say which repositories you believe are
affected and it is triaged across all of them.

In scope: anything reachable in this repository's own source, its dependency tree, its
configuration and its build and release plumbing.

Out of scope: findings that require an attacker to already control the machine running the
code; reports produced by a scanner with no demonstrated impact on this codebase;
vulnerabilities in a third-party dependency that is already tracked by a published
advisory and has no fixed version, which this platform records rather than re-reports.

## Supported versions

Only the `main` branch of each repository is supported. There are no maintained release
branches, and a fix is delivered by moving `main` forward.
