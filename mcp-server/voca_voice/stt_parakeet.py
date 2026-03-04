from __future__ import annotations

import logging
import os
import re
import tempfile

import numpy as np
import soundfile as sf

from .config import SAMPLE_RATE

LOGGER = logging.getLogger(__name__)

_WS_RE = re.compile(r"\s+")


class ParakeetSTT:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None
        self._load_model()

    def _load_model(self) -> None:
        LOGGER.info("Loading Parakeet STT model: %s", self.model_name)
        from parakeet_mlx import from_pretrained

        self._model = from_pretrained(self.model_name)
        LOGGER.info("Parakeet STT model ready")

    def transcribe_array(self, audio: np.ndarray) -> str:
        """Batch transcription via temp WAV file. Kept as fallback/testing."""
        if self._model is None:
            raise RuntimeError("Parakeet model is not initialized")

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
