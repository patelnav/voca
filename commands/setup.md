---
description: First-time setup for the Voca voice interface
---

Walk the user through setting up Voca. Check each prerequisite and help fix anything missing.

## Step 1: Check platform

Voca requires macOS with Apple Silicon (M1 or later). Run `uname -m` — it should return `arm64`. If not, inform the user that Voca only works on Apple Silicon Macs due to MLX dependencies.

## Step 2: Check uv

Run `which uv`. If not found, tell the user to install it: `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Step 3: Install Python dependencies

Run `cd mcp-server && uv sync`. This installs all Python packages including MLX, Parakeet STT, Kokoro TTS, Silero VAD, and sounddevice.

## Step 4: Download models

The STT and TTS models need to be downloaded before first use. Run these commands to pre-download them so the first voice session isn't slow:

```bash
cd mcp-server && uv run python -c "from parakeet_mlx import from_pretrained; from_pretrained('mlx-community/parakeet-tdt-0.6b-v2'); print('STT model ready')"
```

```bash
cd mcp-server && uv run python -c "from mlx_audio.tts.utils import load_model; load_model('mlx-community/Kokoro-82M-bf16'); print('TTS model ready')"
```

Tell the user these downloads are ~500MB total and only happen once. The models are cached locally after the first download.

## Step 5: Check BlackHole

Run `brew list blackhole-2ch 2>/dev/null`. If not installed, run `brew install blackhole-2ch` (ask the user first).

BlackHole is a virtual audio driver that lets Voca capture system audio (not just the mic). Without it, Voca only hears the microphone.

## Step 6: Aggregate audio device

This is the one manual step. The user needs to create an aggregate audio device in macOS Audio MIDI Setup that combines their built-in microphone with BlackHole. Walk them through it:

1. Open **Audio MIDI Setup** (Spotlight → "Audio MIDI Setup")
2. Click the **+** button at the bottom left → **Create Aggregate Device**
3. Check both **Built-in Microphone** and **BlackHole 2ch**
4. Name it something like "Voca Input"
5. Set the clock source to **Built-in Microphone**

Then tell them to set the input device in Voca: they can either set `VOCA_INPUT_DEVICE` env var or use `set_audio_config(input_device="Voca Input")` at runtime.

If the user already has an aggregate device, ask them what it's called and skip this step.

## Step 7: Verify

Run a quick test:
1. Check the MCP server is running: `curl -s http://127.0.0.1:7778/poll?timeout_ms=2000`
   - If it returns JSON (even with empty segments), the server is up
   - If it fails, the MCP server may not have started — check Claude Code's MCP status
2. Ask the user to say something, then poll: `curl -s http://127.0.0.1:7778/poll?timeout_ms=10000`
   - If segments come back with transcribed text, setup is complete
3. Test TTS: call `speak("Setup complete. You should hear this.")` — ask if they heard it

If everything works, tell them to run `/voca:voice` to start voice mode.
