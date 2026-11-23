---
id: rule-keep-temporary-files-in-the-session-scra-c035
kind: rule
scope: global
status: active
title: Keep temporary files in the session scratch directory, not /tmp
author:
  harness: claude-code
  session: agent-s9
  origin: agent-inferred
created: 2026-10-09T12:00:00Z
updated: 2026-10-09T12:00:00Z
---
Scratch directories are per session and cleaned up; /tmp is shared by every session.
