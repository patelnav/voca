---
name: voice-mode
description: >
  Use when the user mentions voice listening, ambient audio, speech recognition,
  wants to talk instead of type, or asks to "start listening" or "turn on voice mode".
---

## Voice Mode

This project has an ambient voice interface via the voca MCP server. When the user wants voice mode:

1. **Poll for speech**: Run a background curl command against the HTTP poll endpoint:
   ```
   curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000'
   ```
   The first poll auto-claims voice focus (revoking any other session) and activates the STT pipeline. Use `run_in_background=true`. When the poll returns, read the output.

2. **Save the token**: The response includes a `token` field. Use it in subsequent polls:
   ```
   curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000&token=<token>'
   ```
   After the first poll, never call `/poll` without `token`.

3. **Check for focus transfer**: If the poll response contains `"error": "focus_transferred"`, another session claimed focus. **Stop polling** and inform the user.

4. **Process speech**: Respond naturally to what was said via text in the Claude Code session.

5. **Re-poll**: After processing, immediately launch another background poll (with the same token) to keep listening.

6. **No TTS by default**: Do not use `speak()` unless the user explicitly asks for voice responses. Respond via text only.

7. **Continue** until the user says to stop or focus is transferred.

Match conversational pace — keep responses brief and natural.
