from __future__ import annotations

from dataclasses import dataclass
import os

SAMPLE_RATE = 16_000
MAX_POLL_TIMEOUT_MS = 55_000

DEFAULT_STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v2"
DEFAULT_TTS_MODEL = "mlx-community/Kokoro-82M-bf16"
DEFAULT_TTS_VOICE = "af_heart"


@dataclass(slots=True)
class AudioConfig:
    mute: bool = False
    input_device: str | None = None
    vad_threshold: float = 0.15
    turn_silence_s: float = 2.5
    segment_silence_s: float = 1.0
    min_segment_duration_s: float = 1.0
    word_threshold: int = 4


@dataclass(frozen=True, slots=True)
class ModelConfig:
    stt_model_name: str = DEFAULT_STT_MODEL
    tts_model_name: str = DEFAULT_TTS_MODEL
    tts_default_voice: str = DEFAULT_TTS_VOICE


@dataclass(frozen=True, slots=True)
class ServerConfig:
    model: ModelConfig

    @classmethod
    def from_env(cls) -> "ServerConfig":
        return cls(
            model=ModelConfig(
                stt_model_name=os.getenv("VOCA_STT_MODEL", DEFAULT_STT_MODEL),
                tts_model_name=os.getenv("VOCA_TTS_MODEL", DEFAULT_TTS_MODEL),
                tts_default_voice=os.getenv("VOCA_TTS_VOICE", DEFAULT_TTS_VOICE),
            )
        )
