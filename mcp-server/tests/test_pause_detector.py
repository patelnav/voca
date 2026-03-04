from __future__ import annotations

from datetime import timedelta

from voca_voice.pause_detector import TurnPauseDetector
from voca_voice.types import TranscriptSegment, utc_now


def _segment(text: str, duration_ms: int = 1200) -> TranscriptSegment:
    return TranscriptSegment(timestamp=utc_now(), text=text, duration_ms=duration_ms)


def test_turn_pause_triggers_after_silence() -> None:
    detector = TurnPauseDetector(word_threshold=200)
    detector.add_segment(_segment("this is a short sentence"), now_monotonic=100.0)

    early = detector.evaluate(turn_silence_s=2.5, now_monotonic=101.0)
    assert not early.should_return

    late = detector.evaluate(turn_silence_s=2.5, now_monotonic=102.7)
    assert late.should_return
    assert late.reason == "turn_pause"


def test_word_threshold_triggers_without_pause() -> None:
    detector = TurnPauseDetector(word_threshold=10)
    detector.add_segment(_segment("one two three four five six seven eight nine ten"), now_monotonic=100.0)

    decision = detector.evaluate(turn_silence_s=10.0, now_monotonic=100.1)
    assert decision.should_return
    assert decision.reason == "word_threshold"


def test_timeout_semantics_marker_behavior() -> None:
    detector = TurnPauseDetector(word_threshold=200)

    marker = detector.make_poll_marker()
    assert not detector.saw_speech_since(marker)

    detector.add_segment(_segment("speech has started"), now_monotonic=100.0)
    assert detector.saw_speech_since(marker)
