---
id: rule-docker-notes-ac01
kind: rule
scope: machine
status: active
title: Docker notes
author:
  harness: claude-code
  session: agent-s5
  origin: agent-inferred
created: 2026-10-12T18:00:00Z
updated: 2026-10-12T18:00:00Z
---
Ask before running `docker system prune` or `docker image prune -a`: the GPU training images take hours to rebuild.
