# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Leeboard, please report it **privately**
rather than opening a public issue.

**Contact:** Open a private security advisory on this repository's **Security** tab on
GitHub ("Report a vulnerability").

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within **7 days**. If the issue is confirmed, a fix will be
released as soon as possible and you will be credited in the release notes (unless you
prefer to remain anonymous).

## What to Know About the Store

Leeboard's store holds instructions that agents read and follow. Anyone who can write to
the store, or to its git remote, can steer every agent that reads it, so keep the store's
repository private and limit who can push to it. Entries are data, not code, but agents
treat them as standing orders.

Leeboard rejects text that looks like a credential (provider-style tokens, private-key
headers, URLs with embedded passwords, bearer tokens) before writing it, and refuses to
log it in the usage record. That check is a backstop with a fixed list of patterns, not a
guarantee: do not put secrets in entries.

`lb bosun --full` starts an LLM agent with shell and file-read tools in the store
directory, as an unattended job. Run it only with a runner and model you trust, and
review what it did with `lb review`.

## Scope

This policy covers the `leeboard` package and its CLI (`lb`, `leeboard`), including store
handling, the credential check, the permission rules for unattended runners, and how
Bosun starts its runner. It does **not** cover the third-party `pi` and `claude` CLIs or
their model providers, or the contents of a user's own store. Report vulnerabilities in
those tools to their respective maintainers.

## Disclosure Policy

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure):
coordinated public disclosure after a fix is available, typically within 90 days of the
initial report.
