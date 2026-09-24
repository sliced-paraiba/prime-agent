---
name: attach-video
description: Load an on-disk video file (MP4, WebM, MOV) into the model's context as a viewable attachment so it can be played back — for clips, screen recordings, or demos. Use this when the user points at a video file and wants it attached to the conversation. Errors clearly on non-video or oversized files.
type: python
python_import: attach_video
---

# Attach Video

Load on-disk video files into the model's context as media attachments. The
video is attached the same way a pasted file is, so it can be played back.

## When to use this

- The user points at a video file and wants it attached to the conversation.
- A clip, screen recording, or demo needs to be in context.

## When NOT to use this

For *programmatic* work on video — extracting frames, measuring duration,
transcoding, computing a hash, comparing files byte-by-byte — process it in the
kernel with a library or tool instead:

```python
import subprocess

subprocess.run(["ffprobe", "-v", "error", "-show_streams", "clip.mp4"])
```

That path does not put the video in the model's context; it only lets you
compute over it. Use `attach_video` when the video itself should be attached.

## Usage

Call the prepared `attach_video` import directly in the Python kernel:

```python
print(await attach_video("clip.mp4"))
print(await attach_video("a.mp4", "b.webm"))
```

Formats are detected by content (magic bytes), not by file extension. The
source file must be at most 80MB, and the stored base64 attachment payload is
capped at 9,000,000 characters (about 6.75MB of raw video, kept just under the
host's 10,000,000-character attachment ceiling); larger files are rejected with
an actionable error before anything is attached. The original file is left
untouched.

Supported formats: MP4, WebM, MOV. The skill errors if a file is not a
supported video file, or if it is too large.
