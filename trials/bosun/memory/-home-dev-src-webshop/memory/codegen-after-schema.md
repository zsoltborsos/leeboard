---
name: codegen-after-schema
description: Run pnpm codegen after any GraphQL schema change in webshop
metadata:
  type: feedback
---

After any change to webshop's GraphQL schema, run `pnpm codegen` and commit the regenerated types in the same commit.

**Why:** the owner asked for this after the 2026-11-02 deploy broke on stale generated types ("never push a schema change without its types").
**How to apply:** whenever a diff touches `schema/*.graphql`.
