// IndexedDB blob cache for reference images. Workaround for Chrome's
// FileSystemHandle permission grants not propagating from the popup context
// to the offscreen document. The popup pre-reads all model/scene/product
// files at Build queue time (user gesture present, permission live) and
// stores raw Blobs here. The offscreen reads Blobs without touching FS
// Access — so it never trips a "permission expired" check.

const DB_NAME = "fashion-image-batch-blobs";
const STORE_NAME = "blobs";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function blobKey(role, relPath) {
  return `${role}::${relPath}`;
}

export async function putBlob(key, blob) {
  const db = await openDb();
  return promisify(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(blob, key)
  );
}

export async function getBlob(key) {
  const db = await openDb();
  return promisify(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)
  );
}

export async function clearAllBlobs() {
  const db = await openDb();
  return promisify(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear()
  );
}

export async function clearBlobsForRolePrefix(role) {
  const db = await openDb();
  const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
  const prefix = `${role}::`;
  return new Promise((resolve, reject) => {
    const request = store.openKeyCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const key = String(cursor.key || "");
      if (key.startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
  });
}

// Resolves a FileSystemFileHandle for a relative path within a directory.
// Used by the popup preloader; the offscreen does not need this for reads.
export async function resolveFileHandle(rootHandle, relPath) {
  const parts = String(relPath || "").split("/").filter(Boolean);
  if (!parts.length) {
    throw new Error("relPath rỗng.");
  }
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i += 1) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return dir.getFileHandle(parts[parts.length - 1]);
}
