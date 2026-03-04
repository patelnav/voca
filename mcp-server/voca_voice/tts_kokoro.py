from __future__ import annotations

import logging
import threading
import time

import numpy as np
import sounddevice as sd
from mlx_audio.tts.utils import load_model

LOGGER = logging.getLogger(__name__)


class KokoroTTS:
    def __init__(self, model_name: str, default_voice: str):
        self._default_voice = default_voice
        self._model_name = model_name
        self._model = None

        self._speak_lock = threading.Lock()
        self._playback_thread: threading.Thread | None = None
        self._playback_stop_event: threading.Event | None = None
        self._speaking = False

        self._load_model()

    def _load_model(self) -> None:
        LOGGER.info("Loading Kokoro TTS model: %s", self._model_name)
        self._model = load_model(self._model_name)
        LOGGER.info("Kokoro TTS model ready")

    def is_speaking(self) -> bool:
        with self._speak_lock:
            return self._speaking

    def stop(self) -> None:
        with self._speak_lock:
            self._stop_playback_locked()

    def speak(self, *, text: str, voice: str | None = None, interrupt: bool = True) -> tuple[str, int]:
        normalized = text.strip()
        if not normalized:
            raise ValueError("text cannot be empty")

        selected_voice = voice or self._default_voice

        # Fast-fail when interruption is disabled and playback is already active.
        with self._speak_lock:
            if self._is_playing_locked() and not interrupt:
                raise RuntimeError("already speaking and interrupt is disabled")

        audio, sample_rate = self._generate_audio(normalized, selected_voice)
        duration_ms = int((audio.shape[0] / sample_rate) * 1000)

        with self._speak_lock:
            interrupted = False

            if self._is_playing_locked():
                if not interrupt:
                    raise RuntimeError("already speaking and interrupt is disabled")
                self._stop_playback_locked()
                interrupted = True

            self._start_playback_locked(audio, sample_rate)

            status = "interrupted_previous" if interrupted else "played"
            return status, duration_ms

    def _is_playing_locked(self) -> bool:
        return self._playback_thread is not None and self._playback_thread.is_alive()

    def _stop_playback_locked(self) -> None:
        if self._playback_stop_event is not None:
            self._playback_stop_event.set()
        sd.stop()

        if self._playback_thread is not None and self._playback_thread.is_alive():
            self._playback_thread.join(timeout=1.0)

        self._speaking = False

    def _start_playback_locked(self, audio: np.ndarray, sample_rate: int) -> None:
        stop_event = threading.Event()
        self._speaking = True

        def _playback_loop() -> None:
            try:
                sd.play(audio, sample_rate, blocking=False)
                expected_s = audio.shape[0] / sample_rate
                start = time.monotonic()

                while time.monotonic() - start < expected_s:
                    if stop_event.wait(0.05):
                        break

                sd.stop()
            finally:
                with self._speak_lock:
                    if self._playback_stop_event is stop_event:
                        self._speaking = False

        self._playback_stop_event = stop_event
        self._playback_thread = threading.Thread(target=_playback_loop, daemon=True, name="voca-tts-playback")
        try:
            self._playback_thread.start()
        except Exception:
            self._speaking = False
            self._playback_thread = None
            self._playback_stop_event = None
            raise

    def _generate_audio(self, text: str, voice: str) -> tuple[np.ndarray, int]:
        if self._model is None:
            raise RuntimeError("TTS model is not initialized")

        results = self._model.generate(
            text=text,
            voice=voice,
            speed=1.0,
            lang_code="a",
            stream=False,
            verbose=False,
        )

        chunks: list[np.ndarray] = []
        sample_rate = int(getattr(self._model, "sample_rate", 24_000))

        for result in results:
            sample_rate = int(getattr(result, "sample_rate", sample_rate))
            result_audio = np.asarray(getattr(result, "audio", result), dtype=np.float32).reshape(-1)
            if result_audio.size:
                chunks.append(result_audio)

        if not chunks:
            raise RuntimeError("TTS model generated no audio")

        return np.concatenate(chunks), sample_rate
