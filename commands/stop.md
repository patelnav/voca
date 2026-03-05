---
description: Stop ambient voice listening mode
---

Stop voice mode by deactivating the voice runtime.

1. **Deactivate runtime** (no MCP call needed):
   - If you have the current poll token, include it.
   - If you do not have a token, call `/deactivate` without one; the server will claim focus and stop cleanly.
   ```bash
   # With token
   curl -s -X POST 'http://127.0.0.1:7778/deactivate?token=<token>'

   # Without token
   curl -s -X POST 'http://127.0.0.1:7778/deactivate'
   ```
2. Confirm to the user that voice mode has been stopped.
