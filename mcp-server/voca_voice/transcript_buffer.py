from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta, timezone
from threading import Lock

from .types import TranscriptSegment, utc_now


class TranscriptRingBuffer:
    """Thread-safe in-memory transcript ring buffer."""

    def __init__(self, retention_minutes: int = 30):
        self._retention = timedelta(minutes=retention_minutes)
        self._segments: deque[TranscriptSegment] = deque()
        self._duration_ms = 0
        self._lock = Lock()

    def add(self, segment: TranscriptSegment) -> None:
        with self._lock:
            self._segments.append(segment)
            self._duration_ms += segment.duration_ms
            self._prune_locked(now=segment.timestamp)

    def query(self, *, since: datetime, limit: int) -> list[TranscriptSegment]:
        with self._lock:
            self._prune_locked()
            results = [s for s in self._segments if s.timestamp >= since]
            if limit > 0:
                results = results[:limit]
            return results

    def segment_count(self) -> int:
        with self._lock:
            self._prune_locked()
            return len(self._segments)

    def duration_seconds(self) -> float:
        with self._lock:
            self._prune_locked()
            return self._duration_ms / 1000.0

    def _prune_locked(self, now: datetime | None = None) -> None:
        if now is None:
            now = utc_now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)

        cutoff = now - self._retention
        while self._segments and self._segments[0].timestamp < cutoff:
            removed = self._segments.popleft()
            self._duration_ms -= removed.duration_ms

        if self._duration_ms < 0:
            self._duration_ms = 0
