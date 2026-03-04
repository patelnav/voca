# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Voca?

Voca is a voice interface for Claude Code — an ambient listener that captures speech via STT. Packaged as a Claude Code plugin with an MCP server for audio I/O. By default, Voca operates in listen-only mode: it transcribes speech and Claude responds via text. TTS (voice responses via `speak()`) is available but off by default — only use it if the user explicitly requests voice output.

## Project Structure

```
.claude-plugin/      # Plugin manifest
mcp-server/          # Python — Audio MCP server (STT, TTS, VAD)
.mcp.json            # MCP server configuration
commands/            # Slash commands (/voca:start, /voca:stop)
skills/              # Auto-activatable skills (voice-mode)
archive/             # Legacy code (old TypeScript impl, experiments)
```

## Voice Interface Architecture

### Audio MCP Server (`mcp-server/`)

Python MCP server (stdio transport) that handles all audio I/O:
- **Audio capture** via `sounddevice` (16kHz mono, configurable input device)
- **Silero VAD** for voice activity detection (512-sample / 32ms windows, threshold 0.15)
- **Parakeet MLX v2** for batch speech-to-text (~0.1s per segment on Apple Silicon)
- **Kokoro via mlx-audio** for text-to-speech
- **Two-tier pause detection**: segment-level (VAD, ~1s) triggers STT; turn-level (~2.5s) triggers tool return
- **HTTP poll endpoint** on port 7778 for low-latency polling (bypasses agent messaging overhead)
- **Ring buffer** of last 30 minutes of transcript
- **Noise filtering**: 1s minimum duration, 2-word minimum per segment

### MCP Tools

| Tool | Behavior |
|------|----------|
| `poll_for_speech(timeout_ms)` | Blocks until conversational pause, word threshold (4+), or timeout. Returns accumulated segments. |
| `get_transcript(since, limit)` | Non-blocking. Returns segments from ring buffer. |
| `speak(text, voice?, interrupt?)` | Generates + plays TTS audio via Kokoro. |
| `get_audio_status()` | Returns listening/speaking/muted state. |
| `set_audio_config(mute?, input_device?, ...)` | Updates audio configuration. |

### Starting Voice Mode

Run `/voca:start` to start the voice polling loop. This begins background HTTP polling for speech. Run `/voca:stop` to deactivate and free all model memory.

### Prerequisites

- MCP server dependencies installed: `cd mcp-server && uv sync`
- **BlackHole** (optional) — `brew install blackhole-2ch` + aggregate audio device for mic + system audio capture. Only needed if you want to capture system audio in addition to the microphone.

## MCP Server Development

```bash
cd mcp-server
uv sync                              # Install dependencies
uv run python -m voca_voice          # Start MCP server standalone (for testing)
```

The MCP server starts automatically when Claude Code opens this project (configured in `.mcp.json`).
