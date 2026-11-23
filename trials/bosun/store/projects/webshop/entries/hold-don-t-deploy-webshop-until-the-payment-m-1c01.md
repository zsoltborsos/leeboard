---
id: hold-don-t-deploy-webshop-until-the-payment-m-1c01
kind: hold
scope: project:webshop
status: active
title: Don't deploy webshop until the owner signs off the payment provider migration
author:
  harness: claude-code
  session: owner-s4
  origin: user-stated
created: 2026-11-14T16:40:00Z
updated: 2026-11-14T16:40:00Z
release: the owner signs off the payment provider migration
blocks: [deploy]
---
The new payment provider is wired up but not reconciled against last month's orders. The owner reviews the reconciliation and says when deploys may resume.
