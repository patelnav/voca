from __future__ import annotations

import asyncio
import json
from pathlib import Path
import socket
import threading
import time
import urllib.error
import urllib.request

import numpy as np
import pytest

from voca_voice.config import AudioConfig
from voca_voice.config import ServerConfig
from voca_voice.server import VoiceRuntime, _create_secondary_server, _start_http_server, create_server
from voca_voice.types import TranscriptSegment, utc_now


def _make_runtime() -> VoiceRuntime:
    return VoiceRuntime(server_config=ServerConfig.from_env())


def _wait_until(condition, timeout_s: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_poll_for_speech_returns_focus_transferred_when_revoked(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = _make_runtime()
    monkeypatch.setattr(runtime, "_activate", lambda: None)
    with runtime._condition:
        runtime._active = True

    result_box: dict[str, dict[str, object]] = {}

    def _run_poll() -> None:
        result_box["result"] = runtime.poll_for_speech(timeout_ms=55_000)

    poll_thread = threading.Thread(target=_run_poll, daemon=True)
    poll_thread.start()

    def _poll_started() -> bool:
        with runtime._condition:
            return runtime._poll_active

    started = _wait_until(_poll_started, timeout_s=1.0)
    assert started, "poll_for_speech did not enter active state"

    runtime.revoke_focus()
    poll_thread.join(timeout=2.0)
    assert not poll_thread.is_alive(), "poll_for_speech did not wake after focus revocation"

    result = result_box["result"]
    assert result["error"] == "focus_transferred"
    assert result["segments"] == []
    assert result["total_words"] == 0


def test_focus_transfer_includes_buffered_segments(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = _make_runtime()
    monkeypatch.setattr(runtime, "_activate", lambda: None)
    with runtime._condition:
        runtime._active = True
        runtime._pause_detector.add_segment(
            TranscriptSegment(timestamp=utc_now(), text="buffered words", duration_ms=350)
        )

    result_box: dict[str, dict[str, object]] = {}

    def _run_poll() -> None:
        result_box["result"] = runtime.poll_for_speech(timeout_ms=55_000)

    poll_thread = threading.Thread(target=_run_poll, daemon=True)
    poll_thread.start()

    def _poll_started() -> bool:
        with runtime._condition:
            return runtime._poll_active

    started = _wait_until(_poll_started, timeout_s=1.0)
    assert started, "poll_for_speech did not enter active state"

    runtime.revoke_focus()
    poll_thread.join(timeout=2.0)
    assert not poll_thread.is_alive(), "poll_for_speech did not wake after focus revocation"

    result = result_box["result"]
    assert result["error"] == "focus_transferred"
    assert [segment["text"] for segment in result["segments"]] == ["buffered words"]
    assert result["total_words"] == 2


def test_claim_and_wait_forces_pipeline_segment_reset() -> None:
    runtime = _make_runtime()

    class _DummyPipeline:
        def __init__(self) -> None:
            self.reset_calls = 0

        def force_segment_reset(self) -> None:
            self.reset_calls += 1

    pipeline = _DummyPipeline()
    with runtime._condition:
        runtime._active = True
        runtime._pipeline = pipeline

    runtime.claim_and_wait(timeout_s=0.01)
    assert pipeline.reset_calls == 1


def test_pipeline_force_segment_reset_flushes_inflight_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    try:
        from voca_voice.audio_pipeline import AudioPipeline
    except ImportError as exc:
        pytest.skip(f"audio pipeline import unavailable in test env: {exc}")

    class _DummyVad:
        def reset_states(self) -> None:
            return None

    class _DummyStt:
        def transcribe_array(self, audio) -> str:
            return "remaining words"

    monkeypatch.setattr(AudioPipeline, "_load_vad_model", lambda self: _DummyVad())
    segments: list[TranscriptSegment] = []
    pipeline = AudioPipeline(
        stt_model=_DummyStt(),
        initial_config=AudioConfig(),
        on_transcript=segments.append,
        is_tts_speaking=lambda: False,
    )

    pipeline._running = True
    pipeline._start_workers()
    pipeline._is_in_speech_segment = True
    pipeline._speech_start_time = utc_now()
    pipeline._speech_audio_chunks = [np.ones(1600, dtype=np.float32)]
    pipeline._speech_sample_count = 1600

    try:
        pipeline.force_segment_reset()
        flushed = _wait_until(lambda: len(segments) == 1, timeout_s=1.0)
        assert flushed, "handoff boundary did not flush in-flight speech"
        assert segments[0].text == "remaining words"
    finally:
        pipeline._raw_audio_queue.put(None)
        if pipeline._vad_thread is not None:
            pipeline._vad_thread.join(timeout=2.0)


def test_claim_voice_focus_revokes_runtime_on_primary(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("mcp.server.fastmcp")

    runtime = _make_runtime()
    mcp = create_server(runtime)
    monkeypatch.setattr("voca_voice.server._claim_focus", lambda: "focus-token")

    before = runtime._focus_epoch
    _, payload = asyncio.run(mcp.call_tool("claim_voice_focus", {}))

    assert payload["token"] == "focus-token"
    assert runtime._focus_epoch == before + 1


def test_secondary_claim_voice_focus_notifies_revoke_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("mcp.server.fastmcp")

    mcp = _create_secondary_server()
    monkeypatch.setattr("voca_voice.server._claim_focus", lambda: "focus-token")
    monkeypatch.setenv("VOCA_HTTP_PORT", "8891")

    observed: dict[str, object] = {}

    class _DummyResponse:
        def __enter__(self) -> "_DummyResponse":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    def _fake_urlopen(url: str, data: bytes | None = None, timeout: float | None = None):
        observed["url"] = url
        observed["data"] = data
        observed["timeout"] = timeout
        return _DummyResponse()

    monkeypatch.setattr("voca_voice.server.urllib.request.urlopen", _fake_urlopen)
    _, payload = asyncio.run(mcp.call_tool("claim_voice_focus", {}))

    assert payload["token"] == "focus-token"
    assert payload["http_port"] == 8891
    assert observed["url"] == "http://127.0.0.1:8891/revoke"
    assert observed["data"] == b""
    assert observed["timeout"] == 2


def test_revoke_endpoint_wakes_runtime_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = _make_runtime()
    port = _free_port()
    monkeypatch.setenv("VOCA_HTTP_PORT", str(port))
    httpd = _start_http_server(runtime)

    try:
        payload = None
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/revoke", data=b"", timeout=2) as response:
                    payload = json.loads(response.read())
                break
            except Exception:
                time.sleep(0.01)

        assert payload is not None, "revoke endpoint did not respond"

        assert payload["status"] == "ok"
        assert runtime._focus_epoch == 1
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_poll_without_token_auto_claims_focus_and_returns_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime = _make_runtime()
    port = _free_port()
    token_path = tmp_path / "focus.token"

    monkeypatch.setenv("VOCA_HTTP_PORT", str(port))
    monkeypatch.setattr("voca_voice.server._TOKEN_PATH", str(token_path))
    monkeypatch.setattr(
        runtime,
        "poll_for_speech",
        lambda timeout_ms: {"segments": [], "total_words": 0, "silence_since_last_speech_ms": 0},
    )

    httpd = _start_http_server(runtime)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/poll?timeout_ms=10", timeout=2) as response:
            payload = json.loads(response.read())

        assert payload["token"]
        assert payload["segments"] == []
        assert payload["total_words"] == 0
        assert token_path.read_text().strip() == payload["token"]
        assert runtime._focus_epoch == 1
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_concurrent_tokenless_polls_trigger_immediate_handoff(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime = _make_runtime()
    port = _free_port()
    token_path = tmp_path / "focus.token"

    monkeypatch.setenv("VOCA_HTTP_PORT", str(port))
    monkeypatch.setattr("voca_voice.server._TOKEN_PATH", str(token_path))
    monkeypatch.setattr(runtime, "_activate", lambda: None)
    with runtime._condition:
        runtime._active = True

    httpd = _start_http_server(runtime)
    first_result: dict[str, object] = {}
    second_result: dict[str, object] = {}

    def _poll(url: str, target: dict[str, object]) -> None:
        with urllib.request.urlopen(url, timeout=2) as response:
            target["payload"] = json.loads(response.read())
            target["finished_at"] = time.monotonic()

    try:
        first_started_at = time.monotonic()
        first_thread = threading.Thread(
            target=_poll,
            args=(f"http://127.0.0.1:{port}/poll?timeout_ms=1000", first_result),
            daemon=True,
        )
        first_thread.start()

        started = _wait_until(lambda: runtime._poll_active, timeout_s=1.0)
        assert started, "first poll did not enter active state"

        second_started_at = time.monotonic()
        second_thread = threading.Thread(
            target=_poll,
            args=(f"http://127.0.0.1:{port}/poll?timeout_ms=50", second_result),
            daemon=True,
        )
        second_thread.start()

        first_thread.join(timeout=0.5)
        assert not first_thread.is_alive(), "first poll was not interrupted by second poll"

        second_thread.join(timeout=1.0)
        assert not second_thread.is_alive(), "second poll did not complete"

        first_payload = first_result["payload"]
        second_payload = second_result["payload"]
        assert first_payload["error"] == "focus_transferred"
        assert first_payload["token"] != second_payload["token"]
        assert first_result["finished_at"] - second_started_at < 0.5
        assert second_payload["segments"] == []
        assert second_payload["total_words"] == 0
        assert second_result["finished_at"] - first_started_at < 1.5
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_poll_with_stale_token_returns_focus_transferred_without_reclaim(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime = _make_runtime()
    port = _free_port()
    token_path = tmp_path / "focus.token"
    token_path.write_text("current-token")

    called = {"poll": 0}

    def _fake_poll(timeout_ms: int) -> dict[str, object]:
        called["poll"] += 1
        return {"segments": [], "total_words": 0, "silence_since_last_speech_ms": 0}

    monkeypatch.setenv("VOCA_HTTP_PORT", str(port))
    monkeypatch.setattr("voca_voice.server._TOKEN_PATH", str(token_path))
    monkeypatch.setattr(runtime, "poll_for_speech", _fake_poll)

    httpd = _start_http_server(runtime)
    try:
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(
                f"http://127.0.0.1:{port}/poll?timeout_ms=10&token=stale-token",
                timeout=2,
            )

        assert exc.value.code == 403
        payload = json.loads(exc.value.read())
        assert payload["error"] == "focus_transferred"
        assert called["poll"] == 0
        assert token_path.read_text().strip() == "current-token"
        assert runtime._focus_epoch == 0
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_deactivate_without_token_claims_focus_and_stops_runtime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime = _make_runtime()
    port = _free_port()
    token_path = tmp_path / "focus.token"
    called = {"deactivate": 0}

    def _fake_deactivate() -> dict[str, object]:
        called["deactivate"] += 1
        return {"status": "ok", "active": False}

    monkeypatch.setenv("VOCA_HTTP_PORT", str(port))
    monkeypatch.setattr("voca_voice.server._TOKEN_PATH", str(token_path))
    monkeypatch.setattr(runtime, "deactivate", _fake_deactivate)

    httpd = _start_http_server(runtime)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/deactivate", data=b"", timeout=2) as response:
            payload = json.loads(response.read())

        assert payload["status"] == "ok"
        assert payload["active"] is False
        assert token_path.read_text().strip()
        assert runtime._focus_epoch == 1
        assert called["deactivate"] == 1
    finally:
        httpd.shutdown()
        httpd.server_close()
