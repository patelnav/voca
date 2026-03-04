---
description: Start ambient voice listening mode
---

Start voice mode for this session. Follow these steps exactly:

1. **Start polling loop**: Run this command in the background:
   ```
   curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000'
   ```
   Use `run_in_background=true` so you stay responsive to the user.

2. **When a poll returns**: Read the output file. If there are segments:
   - Acknowledge or respond to what was said
   - For questions directed at you, answer them
   - For casual conversation, note it briefly without over-responding

3. **Re-poll immediately** after processing each result. Launch another background curl right away.

4. **TTS responses**: When you want to speak aloud, use the `speak(text)` tool. The audio pipeline has a feedback guard — your TTS won't be picked up by the STT.

5. **Keep going** until the user explicitly asks you to stop listening, or the session ends.

Keep responses concise. The user is talking, not typing — match the conversational pace.
