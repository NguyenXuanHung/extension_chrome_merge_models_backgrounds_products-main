// MV3 service worker. Owns chrome.storage state, dispatches run-control
// messages to the active ChatGPT tab and routes file IO through an offscreen
// document (which holds the FileSystem*Handle objects across SW suspends).

import {
  DEFAULT_STATE,
  MESSAGE_TYPES,
  OFFSCREEN_MESSAGE_TYPES,
  OFFSCREEN_TARGET,
  RUN_STATUS,
  STATUS
} from "./lib/config.js";
import {
  appendLog,
  getState,
  patchState,
  recomputeStats,
  setState
} from "./lib/storage.js";
import { resetFailedJobs } from "./lib/jobBuilder.js";

const OFFSCREEN_URL = "offscreen.html";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await getState().catch(() => null);
  if (!existing || !existing.settings) {
    await setState(DEFAULT_STATE);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === OFFSCREEN_TARGET) {
    // Targeted at the offscreen document; let it handle.
    return false;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch(async (error) => {
      await appendLog(error.message || "Unknown error", "error").catch(() => null);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

async function handleMessage(message, _sender) {
  switch (message.type) {
    case MESSAGE_TYPES.GET_STATE:
      return { state: await getState() };
    case MESSAGE_TYPES.UPDATE_SETTINGS:
      return { state: await patchState({ settings: message.settings || {} }) };
    case MESSAGE_TYPES.SET_FOLDER_META: {
      await resetOffscreenHandles();
      return {
        state: await patchState({
          folders: { [message.role]: message.folderMeta || null }
        })
      };
    }
    case MESSAGE_TYPES.SET_PROMPT_FILE:
      return { state: await patchState({ promptFile: message.promptFile || null }) };
    case MESSAGE_TYPES.LOAD_QUEUE:
      return { state: await loadQueue(message.payload) };
    case MESSAGE_TYPES.CLEAR_QUEUE:
      return { state: await patchState({ queue: [], stats: recomputeStats([]) }) };
    case MESSAGE_TYPES.START_RUN:
      return { state: await startRun(message.tabId) };
    case MESSAGE_TYPES.PAUSE_RUN:
      return { state: await updateRunStatus(RUN_STATUS.PAUSED, "Đã pause queue.") };
    case MESSAGE_TYPES.RESUME_RUN:
      return { state: await resumeRun() };
    case MESSAGE_TYPES.STOP_RUN:
      return { state: await updateRunStatus(RUN_STATUS.STOPPED, "Đã stop queue.") };
    case MESSAGE_TYPES.RETRY_FAILED:
      return { state: await retryFailed() };
    case MESSAGE_TYPES.UPDATE_QUEUE_ITEM:
      return { state: await updateQueueItem(message.itemId, message.patch || {}) };
    case MESSAGE_TYPES.APPEND_LOG:
      return { state: await appendLog(message.message, message.level, message.extra || {}) };
    case MESSAGE_TYPES.CLEAR_LOGS:
      return { state: await patchState({ logs: [] }) };
    case MESSAGE_TYPES.CONTENT_STATUS:
      return { state: await patchState(message.patch || {}) };
    case MESSAGE_TYPES.REQUEST_JOB_FILES:
      return await requestJobFiles(message.files);
    case MESSAGE_TYPES.SAVE_IMAGE:
      return await saveImage(message.payload);
    case MESSAGE_TYPES.CHECK_OUTPUT_EXISTS:
      return await checkOutputExists(message.filename);
    case MESSAGE_TYPES.RESET_OFFSCREEN_HANDLES:
      await resetOffscreenHandles();
      return { reset: true };
    case MESSAGE_TYPES.PING:
      return { pong: true };
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

async function loadQueue(payload) {
  const state = await getState();
  const now = new Date().toISOString();
  const queue = payload.queue || [];
  return setState({
    ...state,
    promptFile: payload.promptFile || state.promptFile,
    folders: {
      ...state.folders,
      ...(payload.folders || {})
    },
    queue,
    currentIndex: -1,
    runState: { status: RUN_STATUS.IDLE, lastUpdatedAt: now, startedAt: null, finishedAt: null },
    stats: recomputeStats(queue),
    settings: { ...state.settings, ...(payload.settings || {}) }
  });
}

async function startRun(tabId) {
  const state = await getState();
  if (!state.queue.length) {
    throw new Error("Queue đang trống. Hãy bấm Build queue trước.");
  }

  const targetTabId = tabId || state.selectedTabId || (await getActiveChatGptTabId());
  if (!targetTabId) {
    throw new Error("Không tìm thấy tab ChatGPT đang mở. Hãy mở https://chatgpt.com trước.");
  }

  await ensureContentScript(targetTabId);

  const nextState = await patchState({
    selectedTabId: targetTabId,
    runState: {
      status: RUN_STATUS.RUNNING,
      lastUpdatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null
    }
  });

  await appendLog("Bắt đầu chạy queue.", "info", { tabId: targetTabId });
  await chrome.tabs.sendMessage(targetTabId, { type: MESSAGE_TYPES.START_RUN });
  return nextState;
}

async function resumeRun() {
  const state = await updateRunStatus(RUN_STATUS.RUNNING, "Resume queue.");
  if (state.selectedTabId) {
    await ensureContentScript(state.selectedTabId);
    await chrome.tabs.sendMessage(state.selectedTabId, { type: MESSAGE_TYPES.RESUME_RUN });
  }
  return state;
}

async function updateRunStatus(status, message) {
  const patch = {
    runState: {
      status,
      lastUpdatedAt: new Date().toISOString()
    }
  };
  if (status === RUN_STATUS.STOPPED || status === RUN_STATUS.COMPLETED) {
    patch.runState.finishedAt = new Date().toISOString();
  }
  const state = await patchState(patch);
  await appendLog(message, "info");
  if (state.selectedTabId) {
    try {
      await chrome.tabs.sendMessage(state.selectedTabId, { type: statusToMessage(status) });
    } catch (error) {
      await appendLog(`Content script notify failed: ${error.message}`, "warn");
    }
  }
  return state;
}

function statusToMessage(status) {
  if (status === RUN_STATUS.PAUSED) return MESSAGE_TYPES.PAUSE_RUN;
  if (status === RUN_STATUS.STOPPED) return MESSAGE_TYPES.STOP_RUN;
  return MESSAGE_TYPES.RESUME_RUN;
}

async function retryFailed() {
  const state = await getState();
  const queue = resetFailedJobs(state.queue, state.settings);
  const next = await patchState({
    queue,
    stats: recomputeStats(queue),
    runState: { status: RUN_STATUS.IDLE, lastUpdatedAt: new Date().toISOString() }
  });
  await appendLog("Đã reset job lỗi về pending.", "info");
  return next;
}

async function updateQueueItem(itemId, patch) {
  const state = await getState();
  const queue = state.queue.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
  return patchState({ queue, stats: recomputeStats(queue) });
}

// ---------- Offscreen routing ----------

async function requestJobFiles(files) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_MESSAGE_TYPES.READ_FILE,
    payload: { files }
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Đọc file reference thất bại.");
  }
  return { files: response.files };
}

async function saveImage(payload) {
  if (!payload?.base64) {
    throw new Error("Image payload trống — chuyển dữ liệu giữa content/SW bị mất.");
  }
  const state = await getState();
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_MESSAGE_TYPES.SAVE_IMAGE,
    payload: {
      base64: payload.base64,
      filename: payload.filename,
      mimeType: payload.mimeType || "image/png",
      overwriteExisting: Boolean(state.settings?.overwriteExisting)
    }
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Lưu ảnh vào folder output thất bại.");
  }
  await appendLog(`Đã lưu ${response.filename}.`, "info");
  return { filename: response.filename, method: "filesystem" };
}

async function checkOutputExists(filename) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_MESSAGE_TYPES.CHECK_EXISTS,
    payload: { filename }
  });
  if (!response?.ok) {
    return { exists: false };
  }
  return { exists: response.exists };
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"],
    justification: "Holds the FileSystem*Handle objects (model/scene/product/output) across MV3 service-worker restarts."
  });
}

async function resetOffscreenHandles() {
  try {
    if (!(await chrome.offscreen.hasDocument())) return;
    await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: OFFSCREEN_MESSAGE_TYPES.RESET_HANDLES
    });
  } catch (_error) {
    // Offscreen may be sleeping/missing; will recreate on next save anyway.
  }
}

// ---------- Tab helpers ----------

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.PING });
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["selectors.js", "chatgptAutomation.js", "content.js"]
    });
  }
}

async function getActiveChatGptTabId() {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });
  if (!tabs.length) return null;
  // Prefer the active tab if any of them is active; otherwise take the most
  // recently focused one.
  const active = tabs.find((tab) => tab.active);
  return (active || tabs[0]).id;
}
