---
name: voice-mode
description: >
  Use when the user mentions voice listening, ambient audio, speech recognition,
  wants to talk instead of type, or asks to "start listening" or "turn on voice mode".
---

## Voice Mode

This project has an ambient voice interface via the voca MCP server. When the user wants voice mode:

1. **Poll for speech**: Run background curl commands against the HTTP poll endpoint:
   ```
   curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000'
   ```
   Use `run_in_background=true`. When the poll returns, read the output.

2. **Process speech**: Respond naturally to what was said.

3. **Re-poll**: After processing, immediately launch another background poll to keep listening.

4. **TTS**: Use `speak(text)` to respond audibly. The STT pipeline suppresses its own output to prevent feedback loops.

5. **Continue** until the user says to stop.

Match conversational pace — keep responses brief and natural.
