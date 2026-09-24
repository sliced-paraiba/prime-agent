"""Load on-disk video files into the model's context as media attachments."""

from __future__ import annotations

import base64
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Keep emitted attachments small enough that daemon clients can render and replay
# video-heavy sessions without compressing megabytes of base64 on every update.
_MAX_SOURCE_VIDEO_BYTES = 80_000_000
_MAX_ATTACHMENT_DATA_CHARS = 9_000_000

_VIDEO_FORMATS_LABEL = "MP4, WebM/Matroska, MOV"


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


# Matches VIDEO_MIME_TYPES in src/utils/mime.ts.
def _detect_video_mime(data: bytes) -> str | None:
    brands = _ftyp_brands(data)
    if brands is not None:
        if any(brand in (b"M4A ", b"M4B ") for brand in brands):
            return None
        if data[8:12] == b"qt  ":
            return "video/quicktime"
        return "video/mp4"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        header = data[:512]
        if b"matroska" in header:
            return "video/x-matroska"
        return "video/webm"
    return None


def _encoded_chars(byte_count: int) -> int:
    return ((byte_count + 2) // 3) * 4


def _validate_video(path: str) -> tuple[Path, str]:
    filepath = Path(path).expanduser()
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")

    size = filepath.stat().st_size
    if size > _MAX_SOURCE_VIDEO_BYTES:
        raise ValueError(
            f"{path} is {size // 1_000_000}MB; video must be under "
            f"{_MAX_SOURCE_VIDEO_BYTES // 1_000_000}MB. Trim or re-encode it first."
        )

    with filepath.open("rb") as f:
        head = f.read(512)
    mime_type = _detect_video_mime(head)
    if mime_type is None:
        raise ValueError(
            f"{path} is not a supported video file ({_VIDEO_FORMATS_LABEL}). "
            "Only video can be loaded into context; open other files in the kernel instead."
        )

    encoded_chars = _encoded_chars(size)
    if encoded_chars > _MAX_ATTACHMENT_DATA_CHARS:
        raise ValueError(
            f"{path} would attach as {encoded_chars // 1000}KB base64 "
            f"(limit {_MAX_ATTACHMENT_DATA_CHARS // 1000}KB). "
            "Trim the clip or lower the resolution and bitrate first."
        )

    return filepath, mime_type


def _emit_attachment(filepath: Path, mime_type: str) -> None:
    from rlm import emit

    data_b64 = base64.b64encode(filepath.read_bytes()).decode("ascii")
    emit(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": mime_type, "data": data_b64, "path": str(filepath)},
            "text/plain": f"Loaded video into context: {filepath}",
        }
    )


async def run(*paths: str) -> str:
    """Load one or more on-disk video files into the model's context as attachments.

    Use this when a video file should be attached to the conversation so it can
    be played back — a clip, screen recording, or demo. The file is attached
    the same way a pasted file is.

    Do NOT use this for programmatic video work (extracting frames, measuring
    duration, transcoding, hashing). For that, process the file with a library
    or tool in the kernel instead.

    Args:
        *paths: One or more video paths. Relative, absolute, or `~`-prefixed.
            Supported formats: MP4, WebM/Matroska, MOV, detected by magic bytes.
            Other types (images, audio, documents) are not supported and raise
            an error.

    Returns:
        A short confirmation listing the video files loaded into context.

    Raises:
        FileNotFoundError: If a path does not exist or is not a regular file.
        ValueError: If a file is not a supported video file, is too large as a
            source file, or would exceed the base64 attachment payload cap.
        RuntimeError: If the current model cannot accept video.
    """
    if not paths:
        raise ValueError("attach_video requires at least one video path")

    from rlm import host_request

    info = await host_request("model.info")
    if "video" not in info.get("input", []):
        model_id = info.get("id") or "the current model"
        raise RuntimeError(
            f"{model_id} does not support video input. "
            "Tell the user to switch to an video-capable model to load video into context."
        )

    # Validate every path before emitting anything, so a later failure never
    # leaves a partial subset injected.
    validated = [_validate_video(path) for path in paths]
    for filepath, mime_type in validated:
        _emit_attachment(filepath, mime_type)

    return f"Loaded {len(validated)} video file(s) into context: {', '.join(paths)}"
