# Voca MCP Server

Python MCP server for Voca's voice interface. It captures audio continuously, segments speech with Silero VAD, transcribes with Parakeet MLX, and supports Kokoro TTS playback.

## Requirements

- macOS Apple Silicon (M1+)
- Python 3.10+
- `uv`
- Optional: BlackHole aggregate device for mic + system audio capture

## Install

```bash
cd mcp-server
uv sync
```

## Run standalone

```bash
cd mcp-server
uv run python -m voca_voice
```

## Environment variables

- `VOCA_STT_MODEL` (default: `mlx-community/parakeet-tdt-0.6b-v2`)
- `VOCA_TTS_MODEL` (default: `mlx-community/Kokoro-82M-bf16`)
- `VOCA_TTS_VOICE` (default: `af_heart`)

## MCP tools

- `poll_for_speech(timeout_ms=55000)`
- `get_transcript(since=None, limit=50)`
- `speak(text, voice=None, interrupt=True)`
- `get_audio_status()`
- `set_audio_config(mute=None, input_device=None, vad_threshold=None, turn_silence_s=None)`

`get_audio_status()` includes `input_level_rms` to help detect dead/quiet input devices.
Returned transcript segments may include optional timing keys: `stt_started_at`, `stt_completed_at`, `delivered_at`.

## Notes

- Startup is fail-fast: STT/TTS/VAD initialization errors terminate the server.
- `poll_for_speech` only times out with empty response if no speech occurred during that call.
- Transcript ring buffer is in-memory only (30-minute retention).

## Tests

```bash
cd mcp-server
uv run pytest
```
