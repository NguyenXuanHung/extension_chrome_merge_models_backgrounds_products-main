// Offscreen document. Holds FileSystem*Handle objects across SW restarts and
// services file IO requests:
//   read-file   — reads N reference images by {role, relPath}, returns base64
//   save-image  — writes the rendered PNG to the output folder
//   check-exists — reports whether a filename exists in output
//   reset-handles — clears the in-memory cache (folder picker re-pick)

import { OFFSCREEN_MESSAGE_TYPES, OFFSCREEN_TARGET } from "./lib/config.js";
import { getDirectoryHandleByRole } from "./lib/idb.js";
import { mimeTypeForFilename } from "./lib/fileScanner.js";
import { base64ToArrayBuffer } from "./lib/downloader.js";
import { blobKey, getBlob } from "./lib/fileBlobStore.js";

const handleCache = new Map(); // role → FileSystemDirectoryHandle

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) {
    return false;
  }
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case OFFSCREEN_MESSAGE_TYPES.READ_FILE:
      return readFiles(message.payload);
    case OFFSCREEN_MESSAGE_TYPES.SAVE_IMAGE:
      return saveImage(message.payload);
    case OFFSCREEN_MESSAGE_TYPES.CHECK_EXISTS:
      return checkExists(message.payload);
    case OFFSCREEN_MESSAGE_TYPES.RESET_HANDLES:
      handleCache.clear();
      return { reset: true };
    case OFFSCREEN_MESSAGE_TYPES.PROBE:
      return { alive: true };
    default:
      throw new Error(`Unsupported offscreen message: ${message.type}`);
  }
}

async function readFiles(payload) {
  const requested = payload?.files || [];
  const result = [];
  for (const entry of requested) {
    let blob = null;
    let nameFromFs = null;

    // Primary: pre-loaded blob in IDB (popup wrote it at Build queue time).
    try {
      blob = await getBlob(blobKey(entry.role, entry.relPath));
    } catch (_e) {
      blob = null;
    }

    // Fallback: read directly from FS handle. Used if popup didn't preload
    // (older queue) or the cache was wiped. Permission may not be live in
    // this context — if so, the error message guides the user.
    if (!blob) {
      const root = await ensureHandle(entry.role);
      const fileHandle = await resolveFileHandle(root, entry.relPath);
      const file = await fileHandle.getFile();
      blob = file;
      nameFromFs = file.name;
    }

    const buffer = await blob.arrayBuffer();
    result.push({
      role: entry.role,
      name: entry.name || nameFromFs || entry.relPath.split("/").pop(),
      relPath: entry.relPath,
      base64: arrayBufferToBase64(buffer),
      mimeType: blob.type || mimeTypeForFilename(entry.name || entry.relPath),
      size: buffer.byteLength
    });
  }
  return { files: result };
}

async function saveImage(payload) {
  const directoryHandle = await ensureHandle("output");

  const bytes = base64ToArrayBuffer(payload.base64);
  const blob = new Blob([bytes], { type: payload.mimeType || "image/png" });

  const finalName = payload.overwriteExisting
    ? payload.filename
    : await pickAvailableFilename(directoryHandle, payload.filename);

  const fileHandle = await directoryHandle.getFileHandle(finalName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return { filename: finalName };
}

async function checkExists(payload) {
  try {
    const directoryHandle = await ensureHandle("output");
    const exists = await fileExists(directoryHandle, payload.filename);
    return { exists };
  } catch (_error) {
    return { exists: false };
  }
}

async function ensureHandle(role) {
  if (handleCache.has(role)) {
    return handleCache.get(role);
  }
  const handle = await getDirectoryHandleByRole(role);
  if (!handle) {
    throw new Error(`Chưa chọn folder ${roleLabel(role)}. Mở popup và bấm Choose lại.`);
  }
  // Don't block on queryPermission — Chrome's permission state can read
  // "prompt" in this offscreen context even though the popup just granted
  // permission live. Trust the handle and let the actual read/write throw
  // a real error if permission really is missing. The thrown error from
  // getFile()/createWritable() is descriptive enough for the user.
  handleCache.set(role, handle);
  return handle;
}

async function resolveFileHandle(rootHandle, relPath) {
  const parts = String(relPath || "").split("/").filter(Boolean);
  if (!parts.length) {
    throw new Error("File reference thiếu relPath.");
  }
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i += 1) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return dir.getFileHandle(parts[parts.length - 1]);
}

async function pickAvailableFilename(directoryHandle, filename) {
  const match = filename.match(/^(.*?)(\.[^.]+)?$/);
  const base = match?.[1] || filename;
  const extension = match?.[2] || "";
  let candidate = filename;
  let version = 2;
  while (await fileExists(directoryHandle, candidate)) {
    candidate = `${base}_v${version}${extension}`;
    version += 1;
  }
  return candidate;
}

async function fileExists(directoryHandle, filename) {
  try {
    await directoryHandle.getFileHandle(filename);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function roleLabel(role) {
  if (role === "model") return "mẫu";
  if (role === "scene") return "cảnh";
  if (role === "product") return "sản phẩm";
  if (role === "output") return "output";
  return role;
}

