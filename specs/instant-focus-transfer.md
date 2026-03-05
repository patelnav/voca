# Instant Focus Transfer

## Goal

When a second Claude session starts voice mode, it should take over immediately:

- If session A is actively blocked inside `/poll`, that request should return right away with `error: "focus_transferred"`.
- Any speech captured before the handoff boundary should stay with session A.
- Any speech captured after the handoff boundary should belong to session B.

## Shipped Behavior

The implementation is HTTP-poll driven. There is no separate MCP focus-transfer step.

### Ownership model

- The first `GET /poll` without a `token` claims voice focus by rotating the token file.
- Every later poll from that same session must include `token=<claimed token>`.
- A new tokenless `GET /poll` from another session claims focus again and starts a handoff.
- A poll with a stale token is rejected with `403 {"error":"focus_transferred"}`.

### Immediate handoff while a poll is active

- The HTTP server is a `ThreadingHTTPServer`, so a second `/poll` can be processed while the first `/poll` is still blocked.
- The new tokenless `/poll` calls `runtime.claim_and_wait()`.
- `claim_and_wait()` inserts a segment boundary into the audio pipeline, then increments `_focus_epoch` and wakes the active poll.
- `poll_for_speech()` notices the epoch change and returns immediately with `error: "focus_transferred"`.
- Before returning, `poll_for_speech()` drains any transcript segments that were finalized before the handoff and includes them in the response.

### Speech split at handoff boundary

- The audio worker receives an explicit boundary marker.
- Audio captured before that marker is finalized into a transcript for the old owner.
- Audio captured after that marker starts a fresh segment for the new owner.
- This avoids the old behavior where in-flight speech could be dropped or attributed entirely to the wrong session.

## Request Flow

### Session A starts voice mode

```text
Session A
  GET /poll?timeout_ms=55000
    -> no token provided
    -> claim token A
    -> activate pipeline
    -> block in poll_for_speech()
```

### Session B starts while A is still inside `/poll`

```text
Session B
  GET /poll?timeout_ms=55000
    -> no token provided
    -> claim token B
    -> enqueue audio boundary
    -> bump focus epoch
    -> wake session A poll

Session A
  poll_for_speech() wakes
    -> sees epoch mismatch
    -> drains finalized segments
    -> returns {"error":"focus_transferred", ...}

Session B
  waits for A poll to release
  enters poll_for_speech()
  becomes active owner
```

### Session A is between poll calls

There is no active HTTP request to interrupt. In that case:

- session B still becomes the owner immediately by claiming a new token
- session A learns it lost focus on its next poll attempt because its token is now stale

This is acceptable because the voice loop re-polls immediately after each response.

## Implementation Notes

### Runtime

- `VoiceRuntime` tracks `_focus_epoch`.
- `claim_and_wait()` performs the handoff wake-up and waits briefly for the old poll to release.
- `poll_for_speech()` returns `focus_transferred` on epoch mismatch.

### HTTP server

- `/poll` is the focus-claim entrypoint.
- Missing token means "claim focus".
- Stale token means "focus already transferred".
- The server uses `ThreadingHTTPServer`; a single-threaded server cannot implement this behavior correctly.

### Audio pipeline

- Handoff does not use a blind reset anymore.
- It uses a queued boundary marker so the old session keeps the first half of interrupted speech.
- The new session starts cleanly from the boundary forward.

## Client Contract

- First poll:

```bash
curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000'
```

- Subsequent polls:

```bash
curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000&token=<token>'
```

- The client must not omit `token` after the first poll. A tokenless re-poll is treated as a new focus claim.

## Operational Notes

- Restart the `voca_voice` process after changing server code. The MCP server does not hot-reload Python files.
- Fresh Claude sessions are the safest way to ensure updated command and skill instructions are in effect.
