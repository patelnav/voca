"""
Benchmark: Kyutai STT 1B (streaming) vs Parakeet TDT 0.6B v3 (batch)

Tests both models on the same audio to compare:
- Load time
- Transcription latency
- Output quality
- Streaming behavior (Kyutai only)
"""

import time
import sys
import os

import numpy as np
import sounddevice as sd


SAMPLE_RATE = 16_000
RECORD_SECONDS = 8


def record_audio(seconds: int = RECORD_SECONDS) -> np.ndarray:
    """Record from MacBook Pro Mic."""
    devices = sd.query_devices()
    mic_idx = None
    for i, d in enumerate(devices):
        if "MacBook Pro" in d["name"] and d["max_input_channels"] > 0:
            mic_idx = i
            break

    device_name = devices[mic_idx]["name"] if mic_idx else "default"
    print(f"Recording {seconds}s from [{mic_idx}] {device_name}...")
    print(">>> SPEAK NOW <<<")
    audio = sd.rec(
        int(seconds * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        device=mic_idx,
    )
    sd.wait()
    audio = audio.reshape(-1)
    rms = np.sqrt(np.mean(audio**2))
    peak = np.max(np.abs(audio))
    print(f"Recorded: {audio.shape[0]} samples, RMS={rms:.4f}, peak={peak:.4f}")
    if rms < 0.005:
        print("WARNING: Very low signal — may not contain speech")
    return audio


def resample_to_24k(audio_16k: np.ndarray) -> np.ndarray:
    """Resample 16kHz audio to 24kHz for Kyutai."""
    from scipy.signal import resample_poly
    from fractions import Fraction

    f = Fraction(24000, 16000)  # 3/2
    return resample_poly(audio_16k, f.numerator, f.denominator).astype(np.float32)


def benchmark_kyutai(audio_16k: np.ndarray) -> None:
    """Benchmark Kyutai STT 1B."""
    print("\n" + "=" * 60)
    print("KYUTAI STT 1B (stt-1b-en_fr)")
    print("=" * 60)

    # Load model
    print("Loading model...")
    t0 = time.monotonic()
    from moshi import loaders

    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {device}")

    checkpoint_info = loaders.CheckpointInfo.from_hf_repo("kyutai/stt-1b-en_fr")
    mimi = checkpoint_info.get_mimi(device=device)
    text_tokenizer = checkpoint_info.get_text_tokenizer()
    lm = checkpoint_info.get_moshi(device=device)
    load_time = time.monotonic() - t0
    print(f"Model loaded in {load_time:.2f}s")

    # Resample to 24kHz
    audio_24k = resample_to_24k(audio_16k)
    print(f"Resampled: {len(audio_16k)} @ 16kHz -> {len(audio_24k)} @ 24kHz")

    # Batch inference
    print("\n--- Batch inference ---")
    audio_tensor = torch.from_numpy(audio_24k).unsqueeze(0).unsqueeze(0).to(device)
    print(f"Input tensor shape: {audio_tensor.shape}")

    t0 = time.monotonic()
    from moshi import InferenceState

    state = InferenceState(
        mimi=mimi,
        text_tokenizer=text_tokenizer,
        lm=lm,
        batch_size=1,
        device=device,
    )
    result = state.run(audio_tensor)
    batch_time = time.monotonic() - t0
    print(f"Result: '{result}'")
    print(f"Batch latency: {batch_time:.3f}s")

    # Streaming inference (process in 80ms chunks)
    print("\n--- Streaming inference (80ms chunks) ---")
    FRAME_SIZE = 1920  # 80ms at 24kHz
    num_frames = len(audio_24k) // FRAME_SIZE
    print(f"Total frames: {num_frames} ({num_frames * 80}ms)")

    state2 = InferenceState(
        mimi=mimi,
        text_tokenizer=text_tokenizer,
        lm=lm,
        batch_size=1,
        device=device,
    )

    t0 = time.monotonic()
    partial_results = []
    for i in range(num_frames):
        chunk = audio_24k[i * FRAME_SIZE : (i + 1) * FRAME_SIZE]
        chunk_tensor = torch.from_numpy(chunk).unsqueeze(0).unsqueeze(0).to(device)

        try:
            # Try streaming step if available
            if hasattr(state2, "step"):
                partial = state2.step(chunk_tensor)
            elif hasattr(state2, "run"):
                # Fall back to running on accumulated audio
                accumulated = audio_24k[: (i + 1) * FRAME_SIZE]
                acc_tensor = (
                    torch.from_numpy(accumulated).unsqueeze(0).unsqueeze(0).to(device)
                )
                partial = state2.run(acc_tensor)
            else:
                print("No streaming API found — skipping")
                break

            elapsed = time.monotonic() - t0
            if partial and str(partial).strip():
                partial_results.append((elapsed, str(partial).strip()))
                print(f"  {elapsed:.3f}s: '{partial}'")
        except Exception as e:
            print(f"  Frame {i}: error - {e}")
            break

    stream_time = time.monotonic() - t0
    print(f"Streaming total: {stream_time:.3f}s")
    if partial_results:
        print(f"Time to first text: {partial_results[0][0]:.3f}s")

    return {
        "load_time": load_time,
        "batch_time": batch_time,
        "batch_text": str(result),
        "stream_time": stream_time,
        "first_text_time": partial_results[0][0] if partial_results else None,
    }


def benchmark_parakeet(audio_16k: np.ndarray) -> None:
    """Benchmark Parakeet TDT 0.6B v3 (via parakeet_mlx)."""
    print("\n" + "=" * 60)
    print("PARAKEET TDT 0.6B v3 (current)")
    print("=" * 60)

    # Check if parakeet_mlx is available
    try:
        from parakeet_mlx import from_pretrained
    except ImportError:
        print("parakeet_mlx not installed in this venv — skipping")
        print("(Run from the main MCP server venv to test Parakeet)")
        return None

    # Load model
    print("Loading model...")
    t0 = time.monotonic()
    model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
    load_time = time.monotonic() - t0
    print(f"Model loaded in {load_time:.2f}s")

    # Transcribe via temp file (same as our stt_parakeet.py)
    import tempfile
    import soundfile as sf

    print("\n--- Batch inference ---")
    t0 = time.monotonic()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        temp_path = f.name
    try:
        sf.write(temp_path, audio_16k, SAMPLE_RATE)
        result = model.transcribe(temp_path)
        text = getattr(result, "text", str(result))
    finally:
        os.unlink(temp_path)
    batch_time = time.monotonic() - t0
    print(f"Result: '{text}'")
    print(f"Batch latency: {batch_time:.3f}s")

    return {
        "load_time": load_time,
        "batch_time": batch_time,
        "batch_text": text,
    }


def main():
    print("=" * 60)
    print("STT BENCHMARK: Kyutai STT 1B vs Parakeet TDT 0.6B v3")
    print("=" * 60)

    # Record audio
    audio = record_audio()

    # Run benchmarks
    kyutai_results = benchmark_kyutai(audio)

    parakeet_results = benchmark_parakeet(audio)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    if kyutai_results:
        print(f"Kyutai:   load={kyutai_results['load_time']:.2f}s  "
              f"batch={kyutai_results['batch_time']:.3f}s  "
              f"text='{kyutai_results['batch_text'][:60]}'")
        if kyutai_results.get("first_text_time"):
            print(f"          first_text={kyutai_results['first_text_time']:.3f}s")
    if parakeet_results:
        print(f"Parakeet: load={parakeet_results['load_time']:.2f}s  "
              f"batch={parakeet_results['batch_time']:.3f}s  "
              f"text='{parakeet_results['batch_text'][:60]}'")


if __name__ == "__main__":
    main()
