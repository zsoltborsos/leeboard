---
id: rule-kill-dev-servers-by-port-or-pid-never-wi-c032
kind: rule
scope: global
status: active
title: Kill dev servers by port or PID, never with pkill -f
author:
  harness: claude-code
  session: agent-s8
  origin: agent-inferred
created: 2026-10-06T12:00:00Z
updated: 2026-10-06T12:00:00Z
---
`pkill -f` matched the agent's own shell and killed the session.
