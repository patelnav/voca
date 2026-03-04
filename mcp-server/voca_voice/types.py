from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Any

_WORD_RE = re.compile(r"\b\w+\b")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_z(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso8601(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def count_words(text: str) -> int:
    return len(_WORD_RE.findall(text))


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    timestamp: datetime
    text: str
    duration_ms: int
    stt_started_at: datetime | None = None
    stt_completed_at: datetime | None = None
    delivered_at: datetime | None = None

    def as_dict(self) -> dict[str, Any]:
        data = {
            "timestamp": isoformat_z(self.timestamp),
            "text": self.text,
            "duration_ms": self.duration_ms,
        }
        if self.stt_started_at is not None:
            data["stt_started_at"] = isoformat_z(self.stt_started_at)
        if self.stt_completed_at is not None:
            data["stt_completed_at"] = isoformat_z(self.stt_completed_at)
        if self.delivered_at is not None:
            data["delivered_at"] = isoformat_z(self.delivered_at)
        return data
