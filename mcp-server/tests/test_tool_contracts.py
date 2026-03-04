from __future__ import annotations

from datetime import timezone
import pytest

from voca_voice.config import MAX_POLL_TIMEOUT_MS
from voca_voice.server import (
    clamp_timeout_ms,
    normalize_limit,
    validate_turn_silence,
    validate_vad_threshold,
)
from voca_voice.types import TranscriptSegment, utc_now


def test_clamp_timeout_defaults_and_bounds() -> None:
    assert clamp_timeout_ms(None) == MAX_POLL_TIMEOUT_MS
    assert clamp_timeout_ms(MAX_POLL_TIMEOUT_MS + 5_000) == MAX_POLL_TIMEOUT_MS
    assert clamp_timeout_ms(1) == 1


def test_normalize_limit_defaults_and_bounds() -> None:
    assert normalize_limit(None) == 50
    assert normalize_limit(0) == 1
    assert normalize_limit(9999) == 500


def test_validate_vad_threshold_accepts_valid_range() -> None:
    assert validate_vad_threshold(None) is None
    assert validate_vad_threshold(0.0) == 0.0
    assert validate_vad_threshold(1.0) == 1.0


def test_validate_vad_threshold_rejects_out_of_range() -> None:
    with pytest.raises(ValueError):
        validate_vad_threshold(-0.01)

    with pytest.raises(ValueError):
        validate_vad_threshold(1.01)


def test_validate_turn_silence_rejects_non_positive() -> None:
    assert validate_turn_silence(None) is None
    assert validate_turn_silence(0.1) == 0.1

    with pytest.raises(ValueError):
        validate_turn_silence(0.0)

    with pytest.raises(ValueError):
        validate_turn_silence(-1.0)


def test_transcript_segment_optional_timing_fields_are_exposed() -> None:
    now = utc_now().astimezone(timezone.utc)
    segment = TranscriptSegment(
        timestamp=now,
        text="hello",
        duration_ms=123,
        stt_started_at=now,
        stt_completed_at=now,
        delivered_at=now,
    )
    data = segment.as_dict()
    assert data["text"] == "hello"
    assert "stt_started_at" in data
    assert "stt_completed_at" in data
    assert "delivered_at" in data
