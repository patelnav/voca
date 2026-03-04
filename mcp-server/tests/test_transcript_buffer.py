from __future__ import annotations

from datetime import timedelta

from voca_voice.transcript_buffer import TranscriptRingBuffer
from voca_voice.types import TranscriptSegment, utc_now


def test_retention_prunes_old_entries() -> None:
    buffer = TranscriptRingBuffer(retention_minutes=30)
    now = utc_now()

    old = TranscriptSegment(timestamp=now - timedelta(minutes=31), text="old", duration_ms=1000)
    recent = TranscriptSegment(timestamp=now, text="recent", duration_ms=2000)

    buffer.add(old)
    buffer.add(recent)

    segments = buffer.query(since=now - timedelta(hours=1), limit=50)
    assert [s.text for s in segments] == ["recent"]
    assert buffer.segment_count() == 1


def test_query_since_and_limit_are_applied() -> None:
    buffer = TranscriptRingBuffer(retention_minutes=30)
    now = utc_now()

    s1 = TranscriptSegment(timestamp=now - timedelta(seconds=50), text="a", duration_ms=500)
    s2 = TranscriptSegment(timestamp=now - timedelta(seconds=30), text="b", duration_ms=600)
    s3 = TranscriptSegment(timestamp=now - timedelta(seconds=10), text="c", duration_ms=700)

    buffer.add(s1)
    buffer.add(s2)
    buffer.add(s3)

    results = buffer.query(since=now - timedelta(seconds=40), limit=1)
    assert [s.text for s in results] == ["b"]


def test_duration_seconds_tracks_current_buffer() -> None:
    buffer = TranscriptRingBuffer(retention_minutes=30)
    now = utc_now()

    buffer.add(TranscriptSegment(timestamp=now, text="one", duration_ms=1200))
    buffer.add(TranscriptSegment(timestamp=now + timedelta(seconds=1), text="two", duration_ms=800))

    assert buffer.duration_seconds() == 2.0
