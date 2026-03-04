from __future__ import annotations

from dataclasses import dataclass
import time

from .types import TranscriptSegment, count_words


@dataclass(frozen=True, slots=True)
class PauseDecision:
    should_return: bool
    reason: str | None = None


class TurnPauseDetector:
    """Tracks turn-level return eligibility for poll_for_speech."""

    def __init__(self, *, word_threshold: int = 200):
        self._word_threshold = word_threshold
        self._speech_event_count = 0
        self._pending_words = 0
        self._pending_segments: list[TranscriptSegment] = []
        self._last_speech_monotonic: float | None = None
        self._saw_speech_since_last_drain = False

    def make_poll_marker(self) -> int:
        return self._speech_event_count

    def saw_speech_since(self, marker: int) -> bool:
        return self._speech_event_count > marker

    def add_segment(self, segment: TranscriptSegment, *, now_monotonic: float | None = None) -> None:
        if not segment.text.strip():
            return

        if now_monotonic is None:
            now_monotonic = time.monotonic()

        self._pending_segments.append(segment)
        self._pending_words += count_words(segment.text)
        self._speech_event_count += 1
        self._saw_speech_since_last_drain = True
        self._last_speech_monotonic = now_monotonic

    def pending_segment_count(self) -> int:
        return len(self._pending_segments)

    def pending_duration_ms(self) -> int:
        return sum(s.duration_ms for s in self._pending_segments)

    def silence_since_last_speech_ms(self, *, now_monotonic: float | None = None) -> int:
        if self._last_speech_monotonic is None:
            return 0

        if now_monotonic is None:
            now_monotonic = time.monotonic()

        return max(0, int((now_monotonic - self._last_speech_monotonic) * 1000))

    def evaluate(self, *, turn_silence_s: float, now_monotonic: float | None = None) -> PauseDecision:
        if not self._pending_segments:
            return PauseDecision(False)

        if self._pending_words >= self._word_threshold:
            return PauseDecision(True, "word_threshold")

        if not self._saw_speech_since_last_drain:
            return PauseDecision(False)

        if now_monotonic is None:
            now_monotonic = time.monotonic()

        if self._last_speech_monotonic is None:
            return PauseDecision(False)

        silence_s = now_monotonic - self._last_speech_monotonic
        if silence_s >= turn_silence_s:
            return PauseDecision(True, "turn_pause")

        return PauseDecision(False)

    def drain(self) -> tuple[list[TranscriptSegment], int]:
        segments = list(self._pending_segments)
        words = self._pending_words
        self._pending_segments.clear()
        self._pending_words = 0
        self._saw_speech_since_last_drain = False
        return segments, words
