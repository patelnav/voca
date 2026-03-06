from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime
import logging
from pathlib import Path
import queue
import threading
import time
from typing import Callable

import numpy as np
import sounddevice as sd
import torch

from .config import SAMPLE_RATE, AudioConfig
from .stt_parakeet import ParakeetSTT
from .types import TranscriptSegment, count_words, utc_now

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class _SegmentBoundary:
    done: threading.Event


class AudioPipeline:
    """Capture audio, run VAD off-callback, and transcribe speech segments via batch STT."""

    VAD_CHUNK_SAMPLES = 512
    MIN_SEGMENT_WORDS = 2
    LOW_SIGNAL_RMS_THRESHOLD = 0.001
    LOW_SIGNAL_WARN_AFTER_S = 10.0
    LOW_SIGNAL_WARN_INTERVAL_S = 15.0
    RAW_AUDIO_QUEUE_MAX = 256

    def __init__(
        self,
        *,
        stt_model: ParakeetSTT,
        initial_config: AudioConfig,
        on_transcript: Callable[[TranscriptSegment], None],
        is_tts_speaking: Callable[[], bool],
    ):
        self._stt_model = stt_model
        self._on_transcript = on_transcript
        self._is_tts_speaking = is_tts_speaking

        # Lock-free reference replacement; callback reads this directly.
        self._config_ref = _copy_audio_config(initial_config)

        self._stream: sd.InputStream | None = None
        self._stream_lock = threading.Lock()
        self._running = False

        self._vad_model = self._load_vad_model()
        self._vad_chunks: deque[np.ndarray] = deque()
        self._vad_head_offset = 0
        self._vad_samples_available = 0

        self._is_in_speech_segment = False
        self._segment_silence_s = 0.0

        # Batch STT state
        self._speech_audio_chunks: list[np.ndarray] = []
        self._speech_start_time: datetime | None = None
        self._speech_sample_count = 0

        self._raw_audio_queue: queue.Queue[np.ndarray | _SegmentBoundary | None] = queue.Queue(
            maxsize=self.RAW_AUDIO_QUEUE_MAX
        )

        self._vad_thread: threading.Thread | None = None

        self._queue_drop_count = 0
        self._last_queue_drop_warning_at = 0.0

        self._input_level_rms = 0.0
        self._signal_lock = threading.Lock()
        self._low_signal_started_at: float | None = None
        self._last_low_signal_warning_at = 0.0

    def start(self) -> None:
        if self._running:
            return

        self._running = True
        self._start_workers()
        self._start_stream()

    def stop(self) -> None:
        if not self._running:
            return

        self._running = False
        self._stop_stream()

        self._raw_audio_queue.put(None)

        if self._vad_thread is not None:
            self._vad_thread.join(timeout=2.0)

    def is_listening(self) -> bool:
        with self._stream_lock:
            return self._stream is not None and self._stream.active

    def input_level_rms(self) -> float:
        with self._signal_lock:
            return self._input_level_rms

    def update_config(self, config: AudioConfig) -> None:
        self._config_ref = _copy_audio_config(config)

    def restart_stream(self) -> None:
        self._stop_stream()
        self._start_stream()

    def force_segment_reset(self) -> None:
        """Insert a hard boundary so in-flight audio is finalized for the old owner."""
        marker = _SegmentBoundary(done=threading.Event())
        try:
            self._raw_audio_queue.put(marker, timeout=0.5)
        except queue.Full:
            LOGGER.warning("Failed to enqueue focus transfer boundary; queue remained full")
            return

        if not marker.done.wait(timeout=1.0):
            LOGGER.warning("Timed out waiting for focus transfer boundary to flush")

    def _start_workers(self) -> None:
        self._vad_thread = threading.Thread(target=self._vad_worker_loop, daemon=True, name="voca-vad-worker")
        self._vad_thread.start()

    def _start_stream(self) -> None:
        config = self._config_ref
        resolved_device = _resolve_input_device(config.input_device)
        device_name = _input_device_name(resolved_device)
        channels = _input_device_channels(resolved_device)

        LOGGER.info(
            "Starting audio capture stream (device_index=%s, device_name=%s, channels=%s)",
            resolved_device,
            device_name,
            channels,
        )

        stream = sd.InputStream(
            device=resolved_device,
            samplerate=SAMPLE_RATE,
            channels=channels,
            dtype="float32",
            callback=self._audio_callback,
        )
        stream.start()

        with self._stream_lock:
            self._stream = stream

    def _stop_stream(self) -> None:
        with self._stream_lock:
            stream = self._stream
            self._stream = None

        if stream is None:
            return

        try:
            stream.stop()
        finally:
            stream.close()

    def _load_vad_model(self):
        LOGGER.info("Loading Silero VAD model")

        local_repo = Path(torch.hub.get_dir()) / "snakers4_silero-vad_master"
        if local_repo.exists():
            LOGGER.info("Using local Silero VAD cache: %s", local_repo)
            try:
                model, _ = torch.hub.load(
                    repo_or_dir=str(local_repo),
                    model="silero_vad",
                    source="local",
                    force_reload=False,
                    onnx=False,
                )
                LOGGER.info("Silero VAD model ready")
                return model
            except Exception:
                LOGGER.exception("Failed to load local Silero cache, falling back to remote")

        model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            onnx=False,
            trust_repo=True,
        )
        LOGGER.info("Silero VAD model ready")
        return model

    def _audio_callback(self, indata, frames, time_info, status) -> None:
        if status:
            LOGGER.warning("Audio callback status: %s", status)

        if not self._running:
            return

        data = np.asarray(indata, dtype=np.float32)
        # Downmix multi-channel to mono by averaging across channels
        if data.ndim == 2 and data.shape[1] > 1:
            chunk = data.mean(axis=1)
        else:
            chunk = data.reshape(-1)
        if chunk.size == 0:
            return

        try:
            self._raw_audio_queue.put_nowait(chunk.copy())
        except queue.Full:
            self._queue_drop_count += 1
            try:
                _ = self._raw_audio_queue.get_nowait()
                self._raw_audio_queue.put_nowait(chunk.copy())
            except queue.Empty:
                pass
            except queue.Full:
                pass

            now = time.monotonic()
            if now - self._last_queue_drop_warning_at >= 5.0:
                LOGGER.warning("Raw audio queue overflow; dropped chunks=%s", self._queue_drop_count)
                self._last_queue_drop_warning_at = now

    def _vad_worker_loop(self) -> None:
        while True:
            item = self._raw_audio_queue.get()
            if item is None:
                return

            if isinstance(item, _SegmentBoundary):
                self._finalize_segment(force=True)
                item.done.set()
                continue

            chunk = item
            config = self._config_ref
            rms = _rms(chunk)
            self._update_signal_metrics(rms)

            if config.mute:
                self._reset_segment_state()
                continue

            # Simple echo suppression for MVP: ignore incoming audio while TTS plays.
            if self._is_tts_speaking():
                self._reset_segment_state()
                continue

            is_speech = self._detect_speech(chunk, config.vad_threshold)
            chunk_duration_s = chunk.shape[0] / SAMPLE_RATE

            if is_speech:
                if not self._is_in_speech_segment:
                    self._speech_start_time = utc_now()
                    self._speech_sample_count = 0
                    self._speech_audio_chunks.clear()
                    self._is_in_speech_segment = True

                self._speech_audio_chunks.append(chunk)
                self._speech_sample_count += chunk.shape[0]
                self._segment_silence_s = 0.0
                continue

            if not self._is_in_speech_segment:
                continue

            # In silence after speech — collect trailing audio for context
            self._speech_audio_chunks.append(chunk)
            self._speech_sample_count += chunk.shape[0]
            self._segment_silence_s += chunk_duration_s

            if self._segment_silence_s < config.segment_silence_s:
                continue

            self._finalize_segment(force=False)

    def _detect_speech(self, audio_chunk: np.ndarray, vad_threshold: float) -> bool:
        self._append_vad_samples(audio_chunk)
        speech_detected = False

        while self._vad_samples_available >= self.VAD_CHUNK_SAMPLES:
            vad_frame = self._pop_vad_samples(self.VAD_CHUNK_SAMPLES)
            score = float(self._vad_model(torch.from_numpy(vad_frame), SAMPLE_RATE).item())
            if score >= vad_threshold:
                speech_detected = True

        return speech_detected

    def _append_vad_samples(self, samples: np.ndarray) -> None:
        frame = np.asarray(samples, dtype=np.float32).reshape(-1)
        if frame.size == 0:
            return
        self._vad_chunks.append(frame)
        self._vad_samples_available += frame.shape[0]

    def _pop_vad_samples(self, sample_count: int) -> np.ndarray:
        out = np.empty(sample_count, dtype=np.float32)
        written = 0

        while written < sample_count:
            head = self._vad_chunks[0]
            available = head.shape[0] - self._vad_head_offset
            take = min(sample_count - written, available)

            out[written : written + take] = head[self._vad_head_offset : self._vad_head_offset + take]
            written += take
            self._vad_head_offset += take

            if self._vad_head_offset >= head.shape[0]:
                self._vad_chunks.popleft()
                self._vad_head_offset = 0

        self._vad_samples_available -= sample_count
        return out

    def _reset_segment_state(self) -> None:
        self._is_in_speech_segment = False
        self._segment_silence_s = 0.0
        self._speech_audio_chunks.clear()
        self._speech_start_time = None
        self._speech_sample_count = 0
        self._vad_chunks.clear()
        self._vad_head_offset = 0
        self._vad_samples_available = 0
        if hasattr(self._vad_model, "reset_states"):
            self._vad_model.reset_states()

    def _finalize_segment(self, *, force: bool) -> None:
        if not self._is_in_speech_segment or self._speech_sample_count <= 0:
            self._reset_segment_state()
            return

        duration_ms = int(self._speech_sample_count / SAMPLE_RATE * 1000)
        min_duration_ms = int(self._config_ref.min_segment_duration_s * 1000)
        if not force and duration_ms < min_duration_ms:
            self._reset_segment_state()
            return

        try:
            stt_started_at = utc_now()
            audio = np.concatenate(self._speech_audio_chunks)
            text = self._stt_model.transcribe_array(audio)
            stt_completed_at = utc_now()
            if text and count_words(text) >= self.MIN_SEGMENT_WORDS:
                self._on_transcript(
                    TranscriptSegment(
                        timestamp=self._speech_start_time,
                        text=text,
                        duration_ms=duration_ms,
                        stt_started_at=stt_started_at,
                        stt_completed_at=stt_completed_at,
                    )
                )
        except Exception:
            LOGGER.exception("Failed to transcribe speech segment")
        finally:
            self._reset_segment_state()

    def _update_signal_metrics(self, rms: float) -> None:
        now = time.monotonic()
        with self._signal_lock:
            self._input_level_rms = rms

            if rms >= self.LOW_SIGNAL_RMS_THRESHOLD:
                self._low_signal_started_at = None
                return

            if self._low_signal_started_at is None:
                self._low_signal_started_at = now
                return

            low_duration = now - self._low_signal_started_at
            if low_duration < self.LOW_SIGNAL_WARN_AFTER_S:
                return

            if now - self._last_low_signal_warning_at < self.LOW_SIGNAL_WARN_INTERVAL_S:
                return

            LOGGER.warning(
                "Input audio level remains very low (rms=%.6f for %.1fs). Check microphone/device routing.",
                rms,
                low_duration,
            )
            self._last_low_signal_warning_at = now


def _copy_audio_config(config: AudioConfig) -> AudioConfig:
    return AudioConfig(
        mute=config.mute,
        input_device=config.input_device,
        vad_threshold=config.vad_threshold,
        turn_silence_s=config.turn_silence_s,
        segment_silence_s=config.segment_silence_s,
        min_segment_duration_s=config.min_segment_duration_s,
        word_threshold=config.word_threshold,
    )


def _rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float32), dtype=np.float32)))


def _resolve_input_device(input_device: str | None) -> int | None:
    devices = list(sd.query_devices())

    if input_device is None or not input_device.strip():
        built_in_index = _find_builtin_microphone(devices)
        if built_in_index is not None:
            return built_in_index
        return None

    cleaned = input_device.strip()
    if cleaned.isdigit():
        return int(cleaned)

    lowered = cleaned.lower()
    for index, device in enumerate(devices):
        name = str(device.get("name", ""))
        max_inputs = int(device.get("max_input_channels", 0))
        if max_inputs > 0 and lowered in name.lower():
            return index

    raise ValueError(f"Input device not found: {input_device}")


def _find_builtin_microphone(devices: list[dict]) -> int | None:
    candidates = (
        "built-in microphone",
        "built in microphone",
        "internal microphone",
        "macbook microphone",
        "macbook pro microphone",
        "macbook air microphone",
    )
    for index, device in enumerate(devices):
        name = str(device.get("name", "")).lower()
        max_inputs = int(device.get("max_input_channels", 0))
        if max_inputs <= 0:
            continue
        if any(token in name for token in candidates):
            return index
    return None


def _input_device_channels(device_index: int | None) -> int:
    """Return the number of input channels for the device, defaulting to 1."""
    try:
        if device_index is None:
            default_input = sd.default.device[0] if sd.default.device else None
            if default_input is None:
                return 1
            device = sd.query_devices(default_input)
        else:
            device = sd.query_devices(device_index)
        return max(int(device.get("max_input_channels", 1)), 1)
    except Exception:
        return 1


def _input_device_name(device_index: int | None) -> str:
    try:
        if device_index is None:
            default_input = sd.default.device[0] if sd.default.device else None
            if default_input is None:
                return "system-default"
            device = sd.query_devices(default_input)
            return f"default:{device.get('name', default_input)}"

        device = sd.query_devices(device_index)
        return str(device.get("name", device_index))
    except Exception:
        return "unknown"
