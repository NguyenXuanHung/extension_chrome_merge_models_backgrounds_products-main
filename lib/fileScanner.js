// Walks a FileSystemDirectoryHandle and returns image entries as plain
// {name, relPath} so callers can serialize them into chrome.storage. Filtering
// rules:
//   - extension must be one of SUPPORTED_IMAGE_EXTENSIONS (case insensitive)
//   - leading "." is treated as hidden and skipped
//   - subfolders are walked only when includeSubfolders=true
//   - results are sorted by natural ordering on the relative path

import { SUPPORTED_IMAGE_EXTENSIONS } from "./config.js";
import { naturalSort } from "./naturalSort.js";
import { extension } from "./sanitize.js";

export async function scanDirectoryForImages(directoryHandle, options = {}) {
  const includeSubfolders = Boolean(options.includeSubfolders);
  const results = [];

  await walk(directoryHandle, "", includeSubfolders, results);

  return naturalSort(results, (entry) => entry.relPath);
}

async function walk(directoryHandle, prefix, includeSubfolders, results) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (name.startsWith(".")) {
      continue;
    }
    if (handle.kind === "file") {
      if (!isSupportedImage(name)) continue;
      results.push({
        name,
        relPath: prefix ? `${prefix}/${name}` : name
      });
      continue;
    }
    if (handle.kind === "directory" && includeSubfolders) {
      await walk(handle, prefix ? `${prefix}/${name}` : name, includeSubfolders, results);
    }
  }
}

export function isSupportedImage(filename) {
  return SUPPORTED_IMAGE_EXTENSIONS.includes(extension(filename));
}

export function mimeTypeForFilename(filename) {
  const ext = extension(filename);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}
