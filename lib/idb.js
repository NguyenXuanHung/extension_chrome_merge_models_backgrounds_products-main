// IndexedDB store for FileSystem*Handle objects so they survive popup/SW restarts.
// Permission grants do NOT survive — caller must re-call requestPermission() on a
// user gesture before the next read/write.

import { HANDLE_KEYS, ROLE_TO_HANDLE } from "./config.js";

const DB_NAME = "fashion-image-batch-db";
const STORE_NAME = "handles";
const DB_VERSION = 1;

export async function saveHandle(key, handle) {
  const db = await openDb();
  return promisifyRequest(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(handle, key)
  );
}

export async function getHandle(key) {
  const db = await openDb();
  return promisifyRequest(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)
  );
}

export async function clearHandle(key) {
  const db = await openDb();
  return promisifyRequest(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key)
  );
}

export async function getDirectoryHandleByRole(role) {
  const key = ROLE_TO_HANDLE[role];
  if (!key) {
    throw new Error(`Unknown folder role: ${role}`);
  }
  return getHandle(key);
}

export async function saveDirectoryHandleByRole(role, handle) {
  const key = ROLE_TO_HANDLE[role];
  if (!key) {
    throw new Error(`Unknown folder role: ${role}`);
  }
  return saveHandle(key, handle);
}

export async function getPromptFileHandle() {
  return getHandle(HANDLE_KEYS.PROMPT_FILE);
}

export async function savePromptFileHandle(handle) {
  return saveHandle(HANDLE_KEYS.PROMPT_FILE, handle);
}

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

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
