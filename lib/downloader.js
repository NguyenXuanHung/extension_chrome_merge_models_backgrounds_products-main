// Low-level helpers for moving image bytes around. The canonical save path is
// File System Access API via the offscreen document — this module only wraps
// the chrome.downloads fallback for cases where the user has not picked an
// output folder (or where FS Access permission has lapsed).

const DOWNLOAD_SUBFOLDER = "ChatGPT-Fashion-Batch";

export async function downloadViaChromeDownloads(blob, filename) {
  // chrome.downloads.download requires a URL. Use an object URL so we don't
  // round-trip through base64.
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename: `${DOWNLOAD_SUBFOLDER}/${filename}`,
      saveAs: false,
      conflictAction: "uniquify"
    });
    return { id, filename };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
