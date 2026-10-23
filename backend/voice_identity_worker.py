"""Isolated, CPU-only pretrained speaker inference; stdin/stdout, never audio files."""

import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
MIN_SECONDS = 3
MAX_REFERENCE_SECONDS = 15
MAX_SECONDS = 20
MODEL_NAME = "wespeaker_en_voxceleb_resnet34_LM"
PIPELINE = "sherpa-onnx-wespeaker-16k-v1"


def unit_vector(value):
    vector = np.asarray(value, dtype=np.float64)
    if vector.shape != (256,) or not np.isfinite(vector).all():
        raise ValueError("invalid_embedding")
    norm = float(np.linalg.norm(vector))
    if norm < 1e-8:
        raise ValueError("invalid_embedding")
    return vector / norm


def decode_audio(data: bytes, ffmpeg: str, *, max_seconds: int = MAX_SECONDS):
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        demuxer = "wav"
    elif data.startswith(b"\x1a\x45\xdf\xa3"):
        demuxer = "matroska"
    elif data.startswith(b"OggS"):
        demuxer = "ogg"
    elif data[4:8] == b"ftyp":
        demuxer = "mov"
    else:
        raise ValueError("unsupported_audio")
    try:
        result = subprocess.run(
            [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
             "-protocol_whitelist", "pipe", "-threads", "1", "-f", demuxer,
             "-i", "pipe:0", "-map", "0:a:0", "-vn", "-sn", "-dn",
             "-t", str(max_seconds + 1), "-ac", "1", "-ar", str(SAMPLE_RATE),
             "-threads", "1", "-f", "f32le", "pipe:1"],
            input=data, capture_output=True, timeout=8, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("decode_timeout") from exc
    if result.returncode or len(result.stdout) % 4:
        raise ValueError("invalid_audio")
    samples = np.frombuffer(result.stdout, dtype="<f4").copy()
    if len(samples) < MIN_SECONDS * SAMPLE_RATE:
        raise ValueError("insufficient_audio")
    if len(samples) > max_seconds * SAMPLE_RATE:
        raise ValueError("clip_duration")
    if not np.isfinite(samples).all() or float(np.sqrt(np.mean(samples ** 2))) < 0.003:
        raise ValueError("audio_too_quiet")
    return samples


def run(payload):
    # Recheck in the child immediately before native loading (not only in status).
    path = Path(payload["model_path"])
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != payload["sha256"]:
        raise ValueError("model_checksum_mismatch")
    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(path), num_threads=1, debug=False, provider="cpu",
    )
    if not config.validate():
        raise ValueError("invalid_model")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    if extractor.dim != 256:
        raise ValueError("invalid_model")
    embeddings = []
    for encoded in payload.get("audio", []):
        samples = decode_audio(
            base64.b64decode(encoded, validate=True), payload["ffmpeg"],
            max_seconds=MAX_REFERENCE_SECONDS if payload.get("enrollment") else MAX_SECONDS,
        )
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            raise ValueError("insufficient_audio")
        embeddings.append(unit_vector(extractor.compute(stream)).tolist())
    return {"embeddings": embeddings, "dimension": extractor.dim}


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.loads(sys.stdin.buffer.read(22 * 1048576)))))
    except Exception as error:
        # Never log the audio, vector, path or native exception text.
        reason = str(error) if isinstance(error, ValueError) else "inference_failed"
        allowed = {"model_checksum_mismatch", "invalid_model", "invalid_embedding",
                   "unsupported_audio", "decode_timeout", "invalid_audio", "clip_duration",
                   "audio_too_quiet", "insufficient_audio"}
        print(json.dumps({"error": reason if reason in allowed else "inference_failed"}))
        sys.exit(1)
