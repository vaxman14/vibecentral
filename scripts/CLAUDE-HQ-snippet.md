# Vibe Central session log

When a session did real work (code, docs, config, research that produced a decision), end your
final message of the session with this block, exactly in this shape, as the last thing you write:

```
HQ:
summary: one line of what changed this session
done: task one; task two
open: still open or next step one; next step two
```

Rules: `summary` is one line, no markdown. `done` = tasks completed this session; `open` = tasks
still open or the next steps. Separate items with `;` (or put each on its own `- ` line under the
key). Omit `done` or `open` when there is nothing to list. Skip the block entirely for sessions
that only answered a question or did nothing. The block is read by a SessionEnd hook and shown on
the Vibe Central dashboard; it never affects the code.
