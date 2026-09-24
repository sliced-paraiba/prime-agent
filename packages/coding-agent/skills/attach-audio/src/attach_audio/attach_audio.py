"""Load on-disk audio files into the model's context as media attachments."""

from __future__ import annotations

import base64
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Keep emitted attachments small enough that daemon clients can render and replay
# audio-heavy sessions without compressing megabytes of base64 on every update.
_MAX_SOURCE_AUDIO_BYTES = 25_000_000
_MAX_ATTACHMENT_DATA_CHARS = 6_000_000

_AUDIO_FORMATS_LABEL = "WAV, MP3, M4A/AAC, FLAC, OGG"


def _ftyp_brands(data: bytes) -> list[bytes] | None:
    if len(data) < 12 or data[4:8] != b"ftyp":
        return None
    box_size = int.from_bytes(data[:4], "big")
    end = min(box_size, len(data))
    brands = [data[8:12]]
    if end >= 16:
        compatible = data[16:end]
        brands.extend(compatible[i : i + 4] for i in range(0, len(compatible) - 3, 4))
    return brands


# Matches AUDIO_MIME_TYPES in src/utils/mime.ts.
def _detect_audio_mime(data: bytes) -> tuple[str, str | None] | None:
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav", None
    if data[:4] == b"fLaC":
        return "audio/flac", None
    if data[:4] == b"OggS":
        header = data[:512]
        if b"OpusHead" in header:
            return "audio/ogg", "Ogg Opus codec"
        if b"\x01vorbis" in header:
            return "audio/ogg", "Ogg Vorbis codec"
        return "audio/ogg", None
    if data[:3] == b"ID3":
        return "audio/mpeg", None
    brands = _ftyp_brands(data)
    if brands is not None:
        if any(brand in (b"M4A ", b"M4B ") for brand in brands):
            return "audio/mp4", None
        return None
    if len(data) >= 2 and data[0] == 0xFF:
        if (data[1] & 0xF6) == 0xF0:
            return "audio/aac", None
        if (data[1] & 0xE0) == 0xE0:
            return "audio/mpeg", None
    return None


def _encoded_chars(byte_count: int) -> int:
    return ((byte_count + 2) // 3) * 4


def _validate_audio(path: str) -> tuple[Path, str, str | None]:
    filepath = Path(path).expanduser()
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")

    size = filepath.stat().st_size
    if size > _MAX_SOURCE_AUDIO_BYTES:
        raise ValueError(
            f"{path} is {size // 1_000_000}MB; audio must be under "
            f"{_MAX_SOURCE_AUDIO_BYTES // 1_000_000}MB. Convert it to a smaller file first."
        )

    with filepath.open("rb") as f:
        head = f.read(512)
    detected = _detect_audio_mime(head)
    if detected is None:
        raise ValueError(
            f"{path} is not a supported audio file ({_AUDIO_FORMATS_LABEL}). "
            "Only audio can be loaded into context; open other files in the kernel instead."
        )
    mime_type, note = detected

    encoded_chars = _encoded_chars(size)
    if encoded_chars > _MAX_ATTACHMENT_DATA_CHARS:
        raise ValueError(
            f"{path} would attach as {encoded_chars // 1000}KB base64 "
            f"(limit {_MAX_ATTACHMENT_DATA_CHARS // 1000}KB). "
            "Transcode it to a lower bitrate or shorter clip first."
        )

    return filepath, mime_type, note


def _emit_attachment(filepath: Path, mime_type: str) -> None:
    from rlm import emit

    data_b64 = base64.b64encode(filepath.read_bytes()).decode("ascii")
    emit(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": mime_type, "data": data_b64, "path": str(filepath)},
            "text/plain": f"Loaded audio into context: {filepath}",
        }
    )


async def run(*paths: str) -> str:
    """Load one or more on-disk audio files into the model's context as attachments.

    Use this when an audio file should be attached to the conversation so it
    can be played back — a song, recording, voice note, or sound effect. The
    file is attached the same way a pasted file is.

    Do NOT use this for programmatic audio work (decoding samples, measuring
    duration, transcoding, hashing). For that, process the file with a library
    or tool in the kernel instead.

    Args:
        *paths: One or more audio paths. Relative, absolute, or `~`-prefixed.
            Supported formats: WAV, MP3, M4A/AAC, FLAC, OGG (Vorbis/Opus),
            detected by magic bytes. Other types (images, video, documents) are
            not supported and raise an error.

    Returns:
        A short confirmation listing the audio files loaded into context.

    Raises:
        FileNotFoundError: If a path does not exist or is not a regular file.
        ValueError: If a file is not a supported audio file, is too large as a
            source file, or would exceed the base64 attachment payload cap.
    """
    if not paths:
        raise ValueError("attach_audio requires at least one audio path")

    # Validate every path before emitting anything, so a later failure never
    # leaves a partial subset injected.
    validated = [_validate_audio(path) for path in paths]
    format_notes = []
    for filepath, mime_type, note in validated:
        _emit_attachment(filepath, mime_type)
        if note:
            format_notes.append(f"{filepath}: {note}")

    message = f"Loaded {len(validated)} audio file(s) into context: {', '.join(paths)}"
    if format_notes:
        message += "\nFormat details:\n- " + "\n- ".join(format_notes)
    return message
