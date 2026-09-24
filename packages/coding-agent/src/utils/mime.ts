import { open } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const AUDIO_MIME_TYPES = new Set([
	"audio/wav",
	"audio/x-wav",
	"audio/wave",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/aac",
	"audio/flac",
	"audio/x-flac",
	"audio/ogg",
	"audio/opus",
	"audio/webm",
]);

export const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);

const FILE_TYPE_SNIFF_BYTES = 4100;

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
		if (bytesRead === 0) {
			return null;
		}

		const fileType = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));
		if (!fileType) {
			return null;
		}

		if (!IMAGE_MIME_TYPES.has(fileType.mime)) {
			return null;
		}

		return fileType.mime;
	} finally {
		await fileHandle.close();
	}
}
