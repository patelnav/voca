"""Manual test: record 5s from mic, run through streaming STT, print result."""

import time
import numpy as np
import sounddevice as sd
import soundfile as sf
import mlx.core as mx

SAMPLE_RATE = 16000
RECORD_SECONDS = 5
CHUNK_SAMPLES = 512

print(f"Recording {RECORD_SECONDS}s from default mic...")
audio = sd.rec(int(RECORD_SECONDS * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="float32")
sd.wait()
audio = audio.flatten()
rms = np.sqrt(np.mean(audio**2))
print(f"Recorded {len(audio)} samples, RMS={rms:.4f}")
print(f"  min={audio.min():.6f} max={audio.max():.6f} dtype={audio.dtype}")

# Save for offline debugging
sf.write("/tmp/voca_test_recording.wav", audio, SAMPLE_RATE)
print("  Saved to /tmp/voca_test_recording.wav")

# Check for NaN/Inf
nan_count = np.isnan(audio).sum()
inf_count = np.isinf(audio).sum()
if nan_count or inf_count:
    print(f"  WARNING: {nan_count} NaN, {inf_count} Inf values!")

print("\nLoading Parakeet model...")
from parakeet_mlx import from_pretrained

model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v2")

# --- Streaming test (buffered, matching pipeline behavior) ---
STT_MIN_CHUNK = 3200  # 200ms — minimum for parakeet streaming

print(f"\n=== Streaming STT (VAD-sized chunks buffered to {STT_MIN_CHUNK} samples) ===")
t0 = time.perf_counter()
streamer = model.transcribe_stream(context_size=(256, 256), depth=1)

buf = []
buf_samples = 0
call_count = 0
total_fed = 0
for i in range(0, len(audio), CHUNK_SAMPLES):
    chunk = audio[i : i + CHUNK_SAMPLES]
    buf.append(chunk)
    buf_samples += chunk.shape[0]
    if buf_samples >= STT_MIN_CHUNK:
        combined = np.concatenate(buf)
        call_count += 1
        total_fed += combined.shape[0]
        try:
            streamer.add_audio(mx.array(combined))
        except Exception as e:
            print(f"  CRASH on call #{call_count} (fed {total_fed} total samples, this chunk {combined.shape[0]} samples)")
            print(f"  audio_buffer len: {len(streamer.audio_buffer)}")
            print(f"  mel_buffer shape: {streamer.mel_buffer.shape if streamer.mel_buffer is not None else None}")
            raise
        buf.clear()
        buf_samples = 0

# Flush remainder
if buf:
    combined = np.concatenate(buf)
    call_count += 1
    total_fed += combined.shape[0]
    streamer.add_audio(mx.array(combined))

print(f"  Fed audio in {call_count} calls, {total_fed} total samples")
result = streamer.result
text = getattr(result, "text", str(result))
t1 = time.perf_counter()
print(f"  Text: {text!r}")
print(f"  Time: {t1 - t0:.3f}s")

# --- Batch test (for comparison) ---
print("\n=== Batch STT ===")
import tempfile, soundfile as sf, os

t0 = time.perf_counter()
with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
    tmp = f.name
sf.write(tmp, audio, SAMPLE_RATE)
result2 = model.transcribe(tmp)
os.unlink(tmp)
text2 = getattr(result2, "text", str(result2))
t1 = time.perf_counter()
print(f"  Text: {text2!r}")
print(f"  Time: {t1 - t0:.3f}s")
