<div align="center">
  <h1>🎙️ Voca</h1>
  <p><strong>Give Claude Code the ability to hear and speak.</strong></p>

  <p>
    <a href="https://github.com/patelnav/voca"><img src="https://img.shields.io/badge/Platform-Apple%20Silicon%20(M1%2B)-black?logo=apple&style=flat-square" alt="Apple Silicon Required"></a>
    <img src="https://img.shields.io/badge/Privacy-100%25%20Local-success?style=flat-square" alt="100% Local">
    <img src="https://img.shields.io/badge/Latency-Ultra%20Low-blue?style=flat-square" alt="Low Latency">
  </p>
</div>

---

https://github.com/user-attachments/assets/b46e59c6-129b-48a1-aafa-772585fae60b

**Voca** is a Claude Code plugin that adds an ambient voice interface to your coding sessions. It listens to your microphone, transcribes speech in real-time, and speaks back—all running locally on Apple Silicon. **No cloud APIs, no latency, no data leaving your machine.**

## ✨ Features

- **🗣️ Natural Voice Interface**: Talk to Claude Code naturally as you work.
- **⚡️ Real-time Processing**: Sub-second transcription ensures fluid conversations.
- **🔒 Privacy First**: 100% local inference. Your audio never leaves your machine.
- **🎙️ Advanced Audio Routing**: Seamless text-to-speech and voice activity detection built directly in.

## 🚀 Getting Started

### Prerequisites

All inference runs on-device using MLX. 
> ⚠️ **Requirement:** macOS with Apple Silicon (M1+) is required to run Voca.

### Installation

Add the marketplace and install the plugin:

```bash
/plugin marketplace add patelnav/voca
/plugin install voca@patelnav-voca
```

### Setup & Usage

1. **Configure Devices**: Run the setup command to configure your audio input/output devices and verify that everything is working:
   ```bash
   /voca:setup
   ```

2. **Start a Voice Session**: Once setup is complete, start the ambient voice interface:
   ```bash
   /voca:start
   ```

*Claude will now listen in the background and respond seamlessly to your voice.*

## 🛠️ Tech Stack

Voca is built on cutting-edge local AI technologies to ensure maximum performance and privacy:

| Component | Technology | Description |
|-----------|------------|-------------|
| **Speech-to-Text** | Parakeet MLX v2 | Blazing fast transcription (~0.1s on M-series) |
| **Text-to-Speech** | Kokoro via mlx-audio | High-quality, natural voice generation |
| **Voice Activity** | Silero VAD | Enterprise-grade voice activity detection |
| **Runtime** | Python MCP | Model Context Protocol server over stdio |

