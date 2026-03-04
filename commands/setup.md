---
description: First-time setup for the Voca voice interface
---

Walk the user through setting up Voca. Check each prerequisite and help fix anything missing.

## Step 1: Check platform

Voca requires macOS with Apple Silicon (M1 or later). Run `uname -m` — it should return `arm64`. If not, inform the user that Voca only works on Apple Silicon Macs due to MLX dependencies.

## Step 2: Check uv

Run `which uv`. If not found, tell the user to install it: `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Step 3: Install Python dependencies

Run `cd mcp-server && uv sync`. This installs all Python packages including MLX, Parakeet STT, Kokoro TTS, Silero VAD, sounddevice, and the spacy English model.

## Step 4: Download and verify models

The STT and TTS models need to be downloaded before first use (~500MB total, cached after first download). Run these checks — they'll download if needed and verify the models work:

**Check STT model:**
```bash
cd mcp-server && uv run python -c "from parakeet_mlx import from_pretrained; from_pretrained('mlx-community/parakeet-tdt-0.6b-v2'); print('STT model ready')"
```

**Check TTS model + G2P pipeline (full end-to-end test):**
```bash
cd mcp-server && uv run python -c "
from mlx_audio.tts.utils import load_model
import numpy as np
model = load_model('mlx-community/Kokoro-82M-bf16')
# Test full generation pipeline including G2P (misaki + spacy)
for r in model.generate(text='test', voice='af_heart', lang_code='a'):
    audio = np.asarray(r.audio, dtype=np.float32).reshape(-1)
    print(f'TTS model ready — generated {audio.shape[0]} samples at {r.sample_rate}Hz')
    break
"
```

If the TTS test hangs at "Creating new KokoroPipeline", the spacy model is likely missing. Fix with:
```bash
cd mcp-server && uv pip install en_core_web_sm@https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

Run both model checks in parallel since they're independent.

## Step 5: Check MCP server

Check if the MCP server is running: `curl -s "http://127.0.0.1:7778/poll?timeout_ms=2000"`
- If it returns JSON (even with empty segments), the server is up.
- If it fails, tell the user to run `/mcp` to reconnect the voca server. If that fails, check for zombie processes on port 7778: `lsof -i :7778` — kill them and retry `/mcp`.

## Step 6: Test STT (speech-to-text)

Ask the user to say something, then poll: `curl -s "http://127.0.0.1:7778/poll?timeout_ms=10000"`
- If segments come back with transcribed text, STT works.
- If empty after 10s, check that the correct input device is being used (the MCP server logs which device it opened on startup).

## Step 7: Test TTS (text-to-speech)

Call the `speak` MCP tool: `speak("Setup complete. You should hear this.")`
- Ask the user if they heard audio through their speakers.
- If the speak tool isn't available, the MCP connection may need to be restarted via `/mcp`.
- If speak returns success but no audio is heard, check the output device with `get_audio_status()`.

## Step 8: BlackHole (optional)

BlackHole is a virtual audio driver that lets Voca capture **system audio** in addition to the microphone. This is optional — without it, Voca only hears the mic, which is fine for most use cases.

If the user wants system audio capture:
1. `brew install blackhole-2ch`
2. Open **Audio MIDI Setup** (Spotlight → "Audio MIDI Setup")
3. Click **+** → **Create Aggregate Device**
4. Check both **Built-in Microphone** and **BlackHole 2ch**
5. Name it "Voca Input", set clock source to **Built-in Microphone**
6. Set the input device: `set_audio_config(input_device="Voca Input")` or set `VOCA_INPUT_DEVICE=Voca Input` env var.

## Done

If STT and TTS both work, setup is complete. Tell the user to run `/voca:start` to start voice mode.
