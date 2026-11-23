---
id: rule-never-run-webshop-checkout-locally-in-st-af01
kind: rule
scope: project:webshop
status: active
title: Never run webshop checkout locally in Stripe live mode
author:
  harness: claude-code
  session: agent-s7
  origin: agent-inferred
created: 2026-11-06T10:00:00Z
updated: 2026-11-06T10:00:00Z
---
Local checkout must use test mode; live mode charges real cards.
