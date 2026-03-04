from __future__ import annotations

import logging
import os
import re
import tempfile
import threading

import numpy as np
import soundfile as sf

from .config import SAMPLE_RATE

LOGGER = logging.getLogger(__name__)

_WS_RE = re.compile(r"\s+")


class ParakeetSTT:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None
        self._model_lock = threading.Lock()

    def _load_model(self) -> None:
        if self._model is not None:
            return

        with self._model_lock:
            if self._model is not None:
                return

            LOGGER.info("Loading Parakeet STT model: %s", self.model_name)
            from parakeet_mlx import from_pretrained

            self._model = from_pretrained(self.model_name)
            LOGGER.info("Parakeet STT model ready")

    def ensure_loaded(self) -> None:
        self._load_model()

    def transcribe_array(self, audio: np.ndarray) -> str:
        """Batch transcription via temp WAV file. Kept as fallback/testing."""
        if self._model is None:
            self._load_model()

        if audio.size == 0:
            return ""

        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
                temp_path = temp_file.name

            sf.write(temp_path, audio, SAMPLE_RATE)
            result = self._model.transcribe(temp_path)
            text = getattr(result, "text", str(result))
            return _normalize_text(text)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)


def _normalize_text(text: str) -> str:
    text = _WS_RE.sub(" ", str(text)).strip()
    return text
