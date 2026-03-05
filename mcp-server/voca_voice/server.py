from __future__ import annotations

import fcntl
import gc
from dataclasses import asdict, replace
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import secrets
import threading
import time
from typing import Any, TYPE_CHECKING
from urllib.parse import urlparse, parse_qs
import urllib.request

from .config import AudioConfig, MAX_POLL_TIMEOUT_MS, ServerConfig
from .pause_detector import TurnPauseDetector
from .transcript_buffer import TranscriptRingBuffer
from .types import TranscriptSegment, isoformat_z, parse_iso8601, utc_now

LOGGER = logging.getLogger(__name__)
_TMPDIR = os.environ.get("TMPDIR", "/tmp")
_LOCK_PATH = os.path.join(_TMPDIR, "voca-voice.lock")
_TOKEN_PATH = os.path.join(_TMPDIR, "voca-voice.token")

_SECONDARY_MSG = (
    "Voice runtime is owned by another Claude Code session. "
    "Use that session for voice commands, or stop it first (/voca:stop)."
)


def _token_label(token: str | None) -> str:
    if not token:
        return "<none>"
    return token[:8]


def _try_acquire_lock() -> int | None:
    """Try to acquire the singleton lock. Returns the fd if acquired, None otherwise."""
    fd = os.open(_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.write(fd, f"{os.getpid()}\n".encode())
        os.ftruncate(fd, os.lseek(fd, 0, os.SEEK_CUR))
        return fd
    except OSError:
        os.close(fd)
        return None


def _claim_focus() -> str:
    """Generate a new focus token and write it to the token file. Returns the token."""
    token = secrets.token_urlsafe(16)
    # Atomic write via temp file + rename
    tmp = _TOKEN_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(token)
    os.replace(tmp, _TOKEN_PATH)
    LOGGER.info("Voice focus claimed (token=%s)", _token_label(token))
    return token


def _read_focus_token() -> str:
    """Read the current focus token from disk. Returns empty string if missing."""
    try:
        with open(_TOKEN_PATH) as f:
            return f.read().strip()
    except OSError:
        return ""


if TYPE_CHECKING:
    from .audio_pipeline import AudioPipeline
    from .tts_kokoro import KokoroTTS
    from mcp.server.fastmcp import FastMCP


def clamp_timeout_ms(timeout_ms: int | None) -> int:
    if timeout_ms is None:
        return MAX_POLL_TIMEOUT_MS
    return max(1, min(int(timeout_ms), MAX_POLL_TIMEOUT_MS))


def normalize_limit(limit: int | None, *, default: int = 50) -> int:
    if limit is None:
        return default
    return max(1, min(int(limit), 500))


def validate_vad_threshold(vad_threshold: float | None) -> float | None:
    if vad_threshold is None:
        return None
    value = float(vad_threshold)
    if value < 0.0 or value > 1.0:
        raise ValueError("vad_threshold must be between 0 and 1")
    return value


def validate_turn_silence(turn_silence_s: float | None) -> float | None:
    if turn_silence_s is None:
        return None
    value = float(turn_silence_s)
    if value <= 0.0:
        raise ValueError("turn_silence_s must be > 0")
    return value


class VoiceRuntime:
    def __init__(self, *, server_config: ServerConfig):
        self._server_config = server_config

        self._state_lock = threading.Lock()
        self._condition = threading.Condition(self._state_lock)
        self._activation_lock = threading.Lock()

        self._audio_config = AudioConfig()
        self._ring_buffer = TranscriptRingBuffer(retention_minutes=30)
        self._pause_detector = TurnPauseDetector(word_threshold=self._audio_config.word_threshold)
        self._last_speech_at = None
        self._poll_active = False
        self._focus_epoch = 0
        self._active = False
        self._pipeline: AudioPipeline | None = None
        self._tts: KokoroTTS | None = None

    def start(self) -> None:
        self._activate()

    def stop(self) -> None:
        self._deactivate()

    def deactivate(self) -> dict[str, Any]:
        self._deactivate()
        return {"status": "ok", "active": False}

    def revoke_focus(self) -> None:
        with self._condition:
            self._focus_epoch += 1
            self._condition.notify_all()

    def claim_and_wait(self, timeout_s: float = 2.0) -> None:
        """Revoke focus and wait for any in-progress poll to release."""
        with self._condition:
            pipeline = self._pipeline if self._active else None
            poll_was_active = self._poll_active

        if pipeline is not None:
            try:
                pipeline.force_segment_reset()
            except Exception:
                LOGGER.exception("Failed forcing segment reset during focus transfer")

        with self._condition:
            self._focus_epoch += 1
            self._condition.notify_all()
            LOGGER.info(
                "Focus handoff requested (epoch=%s, active_poll=%s)",
                self._focus_epoch,
                poll_was_active,
            )
            deadline = time.monotonic() + timeout_s
            while self._poll_active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    LOGGER.warning("Timed out waiting for active poll to release during handoff")
                    break
                self._condition.wait(timeout=remaining)
            LOGGER.info("Focus handoff wait complete (poll_active=%s)", self._poll_active)

    def _activate(self) -> None:
        with self._activation_lock:
            if self._active and self._pipeline is not None and self._tts is not None:
                return

            from .audio_pipeline import AudioPipeline
            from .stt_parakeet import ParakeetSTT
            from .tts_kokoro import KokoroTTS

            with self._state_lock:
                config_snapshot = replace(self._audio_config)
                existing_tts = self._tts

            stt_model = None
            tts = existing_tts
            pipeline = None

            try:
                LOGGER.info("Activating voice runtime")
                stt_model = ParakeetSTT(model_name=self._server_config.model.stt_model_name)
                stt_model.ensure_loaded()

                if tts is None:
                    tts = KokoroTTS(
                        model_name=self._server_config.model.tts_model_name,
                        default_voice=self._server_config.model.tts_default_voice,
                    )
                    tts.ensure_loaded()

                pipeline = AudioPipeline(
                    stt_model=stt_model,
                    initial_config=config_snapshot,
                    on_transcript=self._handle_transcript,
                    is_tts_speaking=tts.is_speaking,
                )
                pipeline.start()
            except Exception:
                LOGGER.exception("Failed to activate voice runtime")
                if pipeline is not None:
                    try:
                        pipeline.stop()
                    except Exception:
                        LOGGER.exception("Failed stopping pipeline during activation cleanup")
                if existing_tts is None and tts is not None:
                    try:
                        tts.stop()
                    except Exception:
                        LOGGER.exception("Failed stopping TTS during activation cleanup")
                self._release_model_memory()
                with self._condition:
                    self._active = False
                    self._condition.notify_all()
                raise

            with self._condition:
                self._pipeline = pipeline
                self._tts = tts
                self._active = True
                self._condition.notify_all()

            LOGGER.info("Voice runtime active")

    def _deactivate(self) -> None:
        with self._activation_lock:
            with self._condition:
                pipeline = self._pipeline
                tts = self._tts

                self._pipeline = None
                self._tts = None
                self._active = False
                self._condition.notify_all()

            if pipeline is not None:
                try:
                    pipeline.stop()
                except Exception:
                    LOGGER.exception("Failed stopping audio pipeline")

            if tts is not None:
                try:
                    tts.stop()
                except Exception:
                    LOGGER.exception("Failed stopping TTS")

            self._release_model_memory()

    def _ensure_tts(self) -> KokoroTTS:
        with self._activation_lock:
            if self._tts is not None:
                return self._tts

            from .tts_kokoro import KokoroTTS

            tts = KokoroTTS(
                model_name=self._server_config.model.tts_model_name,
                default_voice=self._server_config.model.tts_default_voice,
            )
            try:
                tts.ensure_loaded()
            except Exception:
                try:
                    tts.stop()
                except Exception:
                    LOGGER.exception("Failed stopping TTS during lazy-load cleanup")
                self._release_model_memory()
                raise

            with self._condition:
                self._tts = tts

            return tts

    def _release_model_memory(self) -> None:
        gc.collect()
        try:
            import torch

            if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                torch.mps.empty_cache()
        except Exception:
            LOGGER.debug("Unable to clear torch MPS cache", exc_info=True)

    def _handle_transcript(self, segment: TranscriptSegment) -> None:
        delivered = replace(segment, delivered_at=utc_now())

        with self._condition:
            self._ring_buffer.add(delivered)
            self._pause_detector.add_segment(delivered)
            self._last_speech_at = delivered.timestamp
            self._condition.notify_all()

    def poll_for_speech(self, timeout_ms: int | None) -> dict[str, Any]:
        self._activate()
        timeout_ms = clamp_timeout_ms(timeout_ms)
        deadline = time.monotonic() + (timeout_ms / 1000.0)

        with self._condition:
            if self._poll_active:
                raise ValueError("poll_for_speech already active")
            self._poll_active = True
            poll_marker = self._pause_detector.make_poll_marker()
            epoch_at_start = self._focus_epoch

        try:
            while True:
                with self._condition:
                    if self._focus_epoch != epoch_at_start:
                        segments, total_words = self._pause_detector.drain()
                        LOGGER.info(
                            "Returning focus_transferred from active poll (segments=%s, total_words=%s)",
                            len(segments),
                            total_words,
                        )
                        return {
                            "error": "focus_transferred",
                            "segments": [segment.as_dict() for segment in segments],
                            "total_words": total_words,
                            "silence_since_last_speech_ms": self._pause_detector.silence_since_last_speech_ms(),
                        }

                    if not self._active:
                        return {
                            "segments": [],
                            "total_words": 0,
                            "silence_since_last_speech_ms": self._pause_detector.silence_since_last_speech_ms(),
                        }

                    turn_silence_s = self._audio_config.turn_silence_s
                    decision = self._pause_detector.evaluate(turn_silence_s=turn_silence_s)
                    if decision.should_return:
                        segments, total_words = self._pause_detector.drain()
                        return {
                            "segments": [segment.as_dict() for segment in segments],
                            "total_words": total_words,
                            "silence_since_last_speech_ms": self._pause_detector.silence_since_last_speech_ms(),
                        }

                    saw_speech = self._pause_detector.saw_speech_since(poll_marker)
                    if not saw_speech and time.monotonic() >= deadline:
                        return {
                            "segments": [],
                            "total_words": 0,
                            "silence_since_last_speech_ms": self._pause_detector.silence_since_last_speech_ms(),
                        }

                    wait_s = 0.2 if saw_speech else max(0.05, deadline - time.monotonic())
                    self._condition.wait(timeout=wait_s)
        finally:
            with self._condition:
                self._poll_active = False
                self._condition.notify_all()

    def get_transcript(self, since: str | None, limit: int | None) -> dict[str, Any]:
        limit_value = normalize_limit(limit)
        if since is None:
            since_ts = utc_now() - timedelta(seconds=60)
        else:
            since_ts = parse_iso8601(since)

        segments = self._ring_buffer.query(since=since_ts, limit=limit_value)
        return {"segments": [segment.as_dict() for segment in segments]}

    def speak(self, text: str, voice: str | None, interrupt: bool | None) -> dict[str, Any]:
        use_interrupt = True if interrupt is None else bool(interrupt)
        tts = self._ensure_tts()
        status, duration_ms = tts.speak(text=text, voice=voice, interrupt=use_interrupt)
        return {"status": status, "duration_ms": duration_ms}

    def get_audio_status(self) -> dict[str, Any]:
        with self._state_lock:
            active = self._active
            last_speech_at = self._last_speech_at
            muted = self._audio_config.mute
            pending_count = self._pause_detector.pending_segment_count()
            pending_duration_s = self._pause_detector.pending_duration_ms() / 1000.0
            pipeline = self._pipeline
            tts = self._tts

        if not active:
            return {
                "status": "dormant",
                "active": False,
                "listening": False,
                "speaking": tts.is_speaking() if tts is not None else False,
                "muted": muted,
                "last_speech_at": isoformat_z(last_speech_at) if last_speech_at is not None else None,
                "buffer_segment_count": pending_count,
                "buffer_duration_s": pending_duration_s,
                "input_level_rms": 0.0,
            }

        return {
            "status": "active",
            "active": True,
            "listening": pipeline.is_listening() if pipeline is not None else False,
            "speaking": tts.is_speaking() if tts is not None else False,
            "muted": muted,
            "last_speech_at": isoformat_z(last_speech_at) if last_speech_at is not None else None,
            "buffer_segment_count": pending_count,
            "buffer_duration_s": pending_duration_s,
            "input_level_rms": pipeline.input_level_rms() if pipeline is not None else 0.0,
        }

    def set_audio_config(
        self,
        *,
        mute: bool | None,
        input_device: str | None,
        vad_threshold: float | None,
        turn_silence_s: float | None,
    ) -> dict[str, Any]:
        validated_vad = validate_vad_threshold(vad_threshold)
        validated_turn = validate_turn_silence(turn_silence_s)

        with self._activation_lock:
            should_restart_stream = False
            with self._state_lock:
                new_config = replace(
                    self._audio_config,
                    mute=self._audio_config.mute if mute is None else bool(mute),
                    vad_threshold=self._audio_config.vad_threshold if validated_vad is None else validated_vad,
                    turn_silence_s=self._audio_config.turn_silence_s if validated_turn is None else validated_turn,
                )
                if input_device is not None and input_device != self._audio_config.input_device:
                    new_config = replace(new_config, input_device=input_device)
                    should_restart_stream = True

                self._audio_config = new_config
                config_snapshot = asdict(new_config)
                pipeline = self._pipeline if self._active else None

            if pipeline is not None:
                pipeline.update_config(new_config)
                if should_restart_stream:
                    pipeline.restart_stream()

        return {"status": "ok", "config": config_snapshot}


def create_server(runtime: VoiceRuntime) -> FastMCP:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("voca-voice")

    @mcp.tool()
    def claim_voice_focus() -> dict[str, Any]:
        """Claim voice focus for this session. Returns a token for HTTP polling. Revokes any previous session's focus."""
        token = _claim_focus()
        runtime.revoke_focus()
        return {
            "token": token,
            "http_port": int(os.getenv("VOCA_HTTP_PORT", "7778")),
        }

    @mcp.tool()
    def poll_for_speech(timeout_ms: int = MAX_POLL_TIMEOUT_MS) -> dict[str, Any]:
        """Block until conversational pause or threshold and return transcript segments."""
        return runtime.poll_for_speech(timeout_ms)

    @mcp.tool()
    def get_transcript(since: str | None = None, limit: int = 50) -> dict[str, Any]:
        """Return recent transcript segments from the in-memory ring buffer."""
        return runtime.get_transcript(since, limit)

    @mcp.tool()
    def speak(text: str, voice: str | None = None, interrupt: bool = True) -> dict[str, Any]:
        """Generate and play TTS audio through the system output device."""
        return runtime.speak(text=text, voice=voice, interrupt=interrupt)

    @mcp.tool()
    def get_audio_status() -> dict[str, Any]:
        """Return runtime status for listening, speaking, and transcript buffer state."""
        return runtime.get_audio_status()

    @mcp.tool()
    def set_audio_config(
        mute: bool | None = None,
        input_device: str | None = None,
        vad_threshold: float | None = None,
        turn_silence_s: float | None = None,
    ) -> dict[str, Any]:
        """Update mutable audio runtime configuration."""
        return runtime.set_audio_config(
            mute=mute,
            input_device=input_device,
            vad_threshold=vad_threshold,
            turn_silence_s=turn_silence_s,
        )

    return mcp


def _create_secondary_server() -> FastMCP:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("voca-voice")

    @mcp.tool()
    def claim_voice_focus() -> dict[str, Any]:
        """Claim voice focus for this session. Returns a token for HTTP polling. Revokes any previous session's focus."""
        port = int(os.getenv("VOCA_HTTP_PORT", "7778"))
        token = _claim_focus()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/revoke", data=b"", timeout=2):
                pass
        except Exception:
            LOGGER.debug("Failed to notify primary runtime of focus revocation", exc_info=True)
        return {
            "token": token,
            "http_port": port,
        }

    @mcp.tool()
    def poll_for_speech(timeout_ms: int = MAX_POLL_TIMEOUT_MS) -> dict[str, Any]:
        """Block until conversational pause or threshold and return transcript segments."""
        return {"error": _SECONDARY_MSG, "segments": [], "total_words": 0}

    @mcp.tool()
    def get_transcript(since: str | None = None, limit: int = 50) -> dict[str, Any]:
        """Return recent transcript segments from the in-memory ring buffer."""
        return {"error": _SECONDARY_MSG, "segments": []}

    @mcp.tool()
    def speak(text: str, voice: str | None = None, interrupt: bool = True) -> dict[str, Any]:
        """Generate and play TTS audio through the system output device."""
        return {"error": _SECONDARY_MSG}

    @mcp.tool()
    def get_audio_status() -> dict[str, Any]:
        """Return runtime status for listening, speaking, and transcript buffer state."""
        return {"status": "secondary", "active": False, "error": _SECONDARY_MSG}

    @mcp.tool()
    def set_audio_config(
        mute: bool | None = None,
        input_device: str | None = None,
        vad_threshold: float | None = None,
        turn_silence_s: float | None = None,
    ) -> dict[str, Any]:
        """Update mutable audio runtime configuration."""
        return {"error": _SECONDARY_MSG}

    return mcp


class _PollHandler(BaseHTTPRequestHandler):
    runtime: VoiceRuntime

    def _check_token(self, params: dict[str, list[str]]) -> bool:
        token = params.get("token", [""])[0].strip()
        current = _read_focus_token()
        if not token or not current or not secrets.compare_digest(token, current):
            self._json_response(403, {"error": "focus_transferred"})
            return False
        return True

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/poll":
            self.send_error(404)
            return

        params = parse_qs(parsed.query)
        timeout_ms = int(params.get("timeout_ms", [str(MAX_POLL_TIMEOUT_MS)])[0])
        token = params.get("token", [""])[0].strip()

        # Tokenless first poll claims focus and takes over immediately.
        current = _read_focus_token()
        if not token:
            token = _claim_focus()
            LOGGER.info("Tokenless /poll claimed focus; waiting for handoff (token=%s)", _token_label(token))
            self.runtime.claim_and_wait()
        elif not current or not secrets.compare_digest(token, current):
            LOGGER.info(
                "Rejecting /poll with stale token (provided=%s, current=%s)",
                _token_label(token),
                _token_label(current),
            )
            self._json_response(403, {"error": "focus_transferred", "segments": [], "total_words": 0})
            return
        else:
            LOGGER.info("Accepted /poll with current token (token=%s)", _token_label(token))

        try:
            result = self.runtime.poll_for_speech(timeout_ms)
            self._json_response(200, {"token": token, **result})
        except ValueError as exc:
            LOGGER.info("Rejecting /poll due to runtime conflict: %s", exc)
            self._json_response(409, {"error": str(exc), "token": token})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/revoke":
            try:
                self.runtime.revoke_focus()
                self._json_response(200, {"status": "ok"})
            except Exception:
                LOGGER.exception("Failed handling /revoke")
                self._json_response(500, {"error": "failed to revoke focus"})
            return

        if parsed.path != "/deactivate":
            self.send_error(404)
            return

        params = parse_qs(parsed.query)
        token = params.get("token", [""])[0].strip()
        if not token:
            _claim_focus()
            self.runtime.claim_and_wait()
        elif not self._check_token(params):
            return

        try:
            result = self.runtime.deactivate()
            self._json_response(200, result)
        except Exception:
            LOGGER.exception("Failed handling /deactivate")
            self._json_response(500, {"error": "failed to deactivate"})

    def _json_response(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.debug("HTTP: %s", format % args)


def _start_http_server(runtime: VoiceRuntime) -> ThreadingHTTPServer:
    port = int(os.getenv("VOCA_HTTP_PORT", "7778"))
    _PollHandler.runtime = runtime
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _PollHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True, name="voca-http")
    thread.start()
    LOGGER.info("HTTP poll endpoint ready at http://127.0.0.1:%d/poll", port)
    return httpd


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    lock_result = _try_acquire_lock()
    if lock_result is None:
        LOGGER.warning(
            "Another voca-voice instance holds the lock (%s). "
            "Starting in secondary mode — voice tools will be unavailable.",
            _LOCK_PATH,
        )
        server = _create_secondary_server()
        try:
            server.run(transport="stdio")
        finally:
            LOGGER.info("voca-voice secondary MCP server stopped")
        return

    lock_fd = lock_result
    LOGGER.info("Acquired singleton lock: %s", _LOCK_PATH)

    config = ServerConfig.from_env()
    runtime = VoiceRuntime(server_config=config)
    server = create_server(runtime)

    httpd = _start_http_server(runtime)
    LOGGER.info("voca-voice MCP server started")

    try:
        server.run(transport="stdio")
    finally:
        httpd.shutdown()
        runtime.stop()
        try:
            os.unlink(_TOKEN_PATH)
        except OSError:
            pass
        os.close(lock_fd)
        LOGGER.info("voca-voice MCP server stopped")


if __name__ == "__main__":
    main()
