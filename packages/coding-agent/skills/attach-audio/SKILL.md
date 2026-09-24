---
name: attach-audio
description: Load an on-disk audio file (WAV, MP3, M4A/AAC, FLAC, OGG/Opus) into the model's context as a playable attachment so it can be heard — for songs, recordings, voice notes, or sound effects. Use this when the user points at an audio file and wants it attached to the conversation. Errors clearly on non-audio or oversized files.
type: python
python_import: attach_audio
---

# Attach Audio

Load on-disk audio files into the model's context as media attachments. The
audio is attached the same way a pasted file is, so it can be played back.

## When to use this

- The user points at an audio file and wants it attached to the conversation.
- A song, recording, voice note, or sound effect needs to be in context.

## When NOT to use this

For *programmatic* work on audio — decoding samples, measuring duration,
transcoding, computing a hash, comparing files byte-by-byte — process it in the
kernel with a library or tool instead:

```python
import wave

with wave.open("song.wav") as wav:
    print(wav.getframerate(), wav.getnframes())
```

That path does not put the audio in the model's context; it only lets you
compute over it. Use `attach_audio` when the audio itself should be attached.

## Usage

Call the prepared `attach_audio` import directly in the Python kernel:

```python
print(await attach_audio("song.mp3"))
print(await attach_audio("a.wav", "b.flac"))
```

Formats are detected by content (magic bytes), not by file extension. The
source file must be at most 25MB, and the stored base64 attachment payload is
capped at 6,000,000 characters (about 4.5MB of raw audio); larger files are
rejected with an actionable error before anything is attached. The original
file is left untouched.

Supported formats: WAV, MP3, M4A/AAC, FLAC, OGG (Vorbis/Opus). The skill errors
if a file is not a supported audio file, or if it is too large.
