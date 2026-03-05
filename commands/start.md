---
description: Start ambient voice listening mode
---

Start voice mode for this session. Follow these steps exactly:

1. **Start polling loop**: Run this command in the background:
   ```
   curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000'
   ```
   The first poll auto-claims voice focus (revoking any other session) and auto-activates the STT pipeline. Use `run_in_background=true` so you stay responsive to the user.

2. **When a poll returns**: Read the output file.
   - The response includes a `token` field — save it for subsequent polls.
   - If the response contains `"error": "focus_transferred"`, voice focus was moved to another session. **Stop polling** and inform the user: "Voice focus was transferred to another session."
   - If there are segments, acknowledge or respond to what was said.
   - For questions directed at you, answer them.
   - For casual conversation, note it briefly without over-responding.

3. **Re-poll immediately** after processing each result. Include the token from the previous response:
   ```
   curl -s 'http://127.0.0.1:7778/poll?timeout_ms=55000&token=<token>'
   ```
   Never call `/poll` without `token` after the first request. Missing token on re-poll can reclaim focus unexpectedly.

4. **No TTS by default**: Respond via text in the Claude Code session, not with `speak()`. Only use TTS if the user explicitly asks you to speak aloud or enables voice responses.

5. **Keep going** until the user explicitly asks you to stop listening, or the session ends.

Keep responses concise. The user is talking, not typing — match the conversational pace.
