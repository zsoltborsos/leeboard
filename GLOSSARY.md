# Leeboard

## Language

**Owner**:
The person whose store it is. Owner entries (`user-stated`) win conflicts; Bosun may revise but never revoke them, and only the owner, or a session acting on their word, may purge.

**Entry**:
One markdown file in the store: a rule, grant, hold, reference, handoff or request, with a scope and a status.

**Brief**:
The session-start orientation `lb brief` prints: one line per active entry in scope, the inbox and a repo-state pointer, at most 8,000 characters.

**Bosun**:
The librarian that keeps the store small and current: a deterministic quick pass (`lb bosun`) and an LLM full pass (`lb bosun --full`).

**Successor**:
The entry whose `supersedes` names a given entry; the **current** entry is the active one at the end of that chain.

**Revision**:
An in-place change to an active entry that keeps its id, records the previous version in `revisions/<id>.jsonl`, and logs a `revised` event.

**Harness**:
A tool that runs agent sessions and talks to Leeboard under a name: `claude-code`, `pi`, `helmraiser`, `funkyoctopus`, `bosun` or `user`.
