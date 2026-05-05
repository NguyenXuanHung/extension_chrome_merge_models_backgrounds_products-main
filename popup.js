// Popup orchestrator. Handles folder/file pickers, settings persistence,
// queue building (cross-product) and run controls. Long-running work happens
// in the content script — this popup only kicks it off via the SW.

import {
  ASPECT_RATIOS,
  DEFAULT_SETTINGS,
  FOLDER_ROLES,
  MESSAGE_TYPES,
  RUN_STATUS
} from "./lib/config.js";
import {
  getDirectoryHandleByRole,
  getPromptFileHandle,
  saveDirectoryHandleByRole,
  savePromptFileHandle
} from "./lib/idb.js";
import { scanDirectoryForImages } from "./lib/fileScanner.js";
import { buildJobs } from "./lib/jobBuilder.js";
import { splitPrompts } from "./lib/promptParser.js";
import { buildCsvExport, buildJsonExport, downloadTextAsFile } from "./lib/logger.js";
import {
  blobKey,
  clearBlobsForRolePrefix,
  putBlob,
  resolveFileHandle
} from "./lib/fileBlobStore.js";

const $ = (id) => document.getElementById(id);

const elements = {
  pickButtons: Array.from(document.querySelectorAll("[data-pick]")),
  choosePromptFileBtn: $("choose-prompt-file-btn"),
  promptFileLabel: $("prompt-file-label"),
  promptFileMeta: $("prompt-file-meta"),
  folderLabels: {
    model: $("folder-label-model"),
    scene: $("folder-label-scene"),
    product: $("folder-label-product"),
    output: $("folder-label-output")
  },
  folderCounts: {
    model: $("folder-count-model"),
    scene: $("folder-count-scene"),
    product: $("folder-count-product"),
    output: $("folder-count-output")
  },
  includeSubfolders: $("include-subfolders"),
  prefixInput: $("prefix-input"),
  aspectRatioSelect: $("aspect-ratio-select"),
  delayInput: $("delay-input"),
  retryInput: $("retry-input"),
  resultTimeoutInput: $("result-timeout-input"),
  resumeFailedCheckbox: $("resume-failed-checkbox"),
  skipExistingCheckbox: $("skip-existing-checkbox"),
  overwriteCheckbox: $("overwrite-checkbox"),
  mockModeCheckbox: $("mock-mode-checkbox"),
  mockWarning: $("mock-warning"),
  validationList: $("validation-list"),
  buildQueueBtn: $("build-queue-btn"),
  startBtn: $("start-btn"),
  pauseBtn: $("pause-btn"),
  resumeBtn: $("resume-btn"),
  stopBtn: $("stop-btn"),
  retryBtn: $("retry-btn"),
  exportJsonBtn: $("export-json-btn"),
  exportCsvBtn: $("export-csv-btn"),
  openOptionsBtn: $("open-options-btn"),
  jobCount: $("job-count"),
  runStateBadge: $("run-state-badge"),
  // Stats
  statTotal: $("stat-total"),
  statDone: $("stat-done"),
  statRunning: $("stat-running"),
  statFailed: $("stat-failed"),
  statSkipped: $("stat-skipped"),
  statPending: $("stat-pending"),
  progressBar: $("progress-bar"),
  currentJobSummary: $("current-job-summary"),
  timeStarted: $("time-started"),
  timeFinished: $("time-finished"),
  queueList: $("queue-list"),
  logList: $("log-list")
};

// Popup-only state for handles (kept in IDB across sessions, but we cache the
// scanned listings in chrome.storage so the offscreen doc can resolve files
// later in the run).
let currentState = null;
const folderListings = {
  model: [],
  scene: [],
  product: []
};

bootstrap().catch(showFatalError);

async function bootstrap() {
  bindEvents();
  currentState = await getState();
  await rehydrateFolderListingsFromState();
  render(currentState);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.appState) return;
    currentState = changes.appState.newValue;
    render(currentState);
  });
}

function bindEvents() {
  elements.pickButtons.forEach((button) => {
    button.addEventListener("click", () => withErrors(() => pickFolder(button.dataset.pick)));
  });
  elements.choosePromptFileBtn.addEventListener("click", () => withErrors(pickPromptFile));
  elements.includeSubfolders.addEventListener("change", () => withErrors(handleSubfoldersToggle));

  [
    elements.prefixInput,
    elements.aspectRatioSelect,
    elements.delayInput,
    elements.retryInput,
    elements.resultTimeoutInput,
    elements.resumeFailedCheckbox,
    elements.skipExistingCheckbox,
    elements.overwriteCheckbox,
    elements.mockModeCheckbox
  ].forEach((el) => {
    el.addEventListener("change", () => withErrors(persistSettings));
    el.addEventListener("input", () => withErrors(persistSettings));
  });

  elements.buildQueueBtn.addEventListener("click", () => withErrors(buildQueue));

  elements.startBtn.addEventListener("click", () => withErrors(() => sendRunCommand(MESSAGE_TYPES.START_RUN)));
  elements.pauseBtn.addEventListener("click", () => withErrors(() => sendRunCommand(MESSAGE_TYPES.PAUSE_RUN)));
  elements.resumeBtn.addEventListener("click", () => withErrors(() => sendRunCommand(MESSAGE_TYPES.RESUME_RUN)));
  elements.stopBtn.addEventListener("click", () => withErrors(() => sendRunCommand(MESSAGE_TYPES.STOP_RUN)));
  elements.retryBtn.addEventListener("click", () => withErrors(() => sendRunCommand(MESSAGE_TYPES.RETRY_FAILED)));

  elements.exportJsonBtn.addEventListener("click", () => withErrors(exportJson));
  elements.exportCsvBtn.addEventListener("click", () => withErrors(exportCsv));
  elements.openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

// ---------- Folder pickers ----------

async function pickFolder(role) {
  if (!window.showDirectoryPicker) {
    throw new Error("Trình duyệt không hỗ trợ showDirectoryPicker.");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await saveDirectoryHandleByRole(role, handle);

  let folderMeta;
  if (role === FOLDER_ROLES.OUTPUT) {
    folderMeta = { name: handle.name, pickedAt: new Date().toISOString() };
  } else {
    const settings = readSettingsFromForm();
    const files = await scanDirectoryForImages(handle, { includeSubfolders: settings.includeSubfolders });
    folderListings[role] = files;
    folderMeta = {
      name: handle.name,
      count: files.length,
      files,
      pickedAt: new Date().toISOString()
    };
  }

  await sendMessage({ type: MESSAGE_TYPES.SET_FOLDER_META, role, folderMeta });
}

async function pickPromptFile() {
  if (!window.showOpenFilePicker) {
    throw new Error("Trình duyệt không hỗ trợ showOpenFilePicker.");
  }
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [{ description: "Prompt template", accept: { "text/plain": [".txt"] } }]
  });
  await savePromptFileHandle(handle);
  const file = await handle.getFile();
  const content = await file.text();
  await sendMessage({
    type: MESSAGE_TYPES.SET_PROMPT_FILE,
    promptFile: { name: file.name, content, pickedAt: new Date().toISOString() }
  });
}

async function handleSubfoldersToggle() {
  await persistSettings();
  // Re-scan the three reference folders so counts match the new policy.
  for (const role of [FOLDER_ROLES.MODEL, FOLDER_ROLES.SCENE, FOLDER_ROLES.PRODUCT]) {
    const handle = await getDirectoryHandleByRole(role).catch(() => null);
    if (!handle) continue;
    try {
      // Re-request permission so we can scan again on this user gesture.
      const perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") continue;
      const settings = readSettingsFromForm();
      const files = await scanDirectoryForImages(handle, { includeSubfolders: settings.includeSubfolders });
      folderListings[role] = files;
      await sendMessage({
        type: MESSAGE_TYPES.SET_FOLDER_META,
        role,
        folderMeta: { name: handle.name, count: files.length, files, pickedAt: new Date().toISOString() }
      });
    } catch (_error) {
      // Swallow — user can re-pick the folder if needed.
    }
  }
}

// ---------- Queue build / start ----------

async function buildQueue() {
  const settings = readSettingsFromForm();
  await persistSettings();

  const errors = validateForBuild();
  if (errors.length) {
    showValidation(errors);
    return;
  }

  const promptHandle = await getPromptFileHandle().catch(() => null);
  if (!promptHandle) {
    throw new Error("Chưa chọn prompt.txt.");
  }
  // Re-request permission to read the file again (refreshes any stale grant).
  const perm = await promptHandle.requestPermission({ mode: "read" });
  if (perm !== "granted") {
    throw new Error("Permission đọc prompt.txt bị từ chối.");
  }
  const promptContent = await (await promptHandle.getFile()).text();

  // Make sure listings are populated even if the popup was just reopened.
  await rehydrateFolderListingsFromState();
  const modelFiles = folderListings.model;
  const sceneFiles = folderListings.scene;
  const productFiles = folderListings.product;

  if (!modelFiles.length || !sceneFiles.length || !productFiles.length) {
    throw new Error("Mỗi folder cần ít nhất 1 ảnh hợp lệ (jpg/png/jpeg/webp).");
  }

  // Split prompt.txt by `===` (each block = 1 prompt). Total jobs =
  // prompts × models × scenes × products.
  const promptTemplates = splitPrompts(promptContent, "===");
  if (!promptTemplates.length) {
    throw new Error("prompt.txt không có nội dung hợp lệ.");
  }

  // Pre-read every reference file into IDB as a Blob. Done while we still
  // have a live user gesture + popup-context permission. The offscreen will
  // read these blobs at run time without needing FS Access (Chrome doesn't
  // reliably propagate FS handle grants from popup → offscreen across
  // restarts, so the offscreen-side queryPermission can return "prompt"
  // even after the popup just granted readwrite).
  await preloadReferenceBlobs(modelFiles, sceneFiles, productFiles);

  const queue = buildJobs({
    promptTemplates,
    modelFiles,
    sceneFiles,
    productFiles,
    settings
  });

  if (currentState?.settings?.resumeFromLastFailed && Array.isArray(currentState?.queue)) {
    // Carry forward DONE/SKIPPED status if the same triple appears with the
    // same outputFilename — that way restart-after-crash skips finished work.
    const finishedKeys = new Set(
      currentState.queue
        .filter((j) => j.status === "done" || j.status === "skipped")
        .map((j) => j.outputFilename)
    );
    queue.forEach((job) => {
      if (finishedKeys.has(job.outputFilename)) {
        job.status = "skipped";
        job.errorMessage = "Đã hoàn thành ở lần chạy trước.";
      }
    });
  }

  await sendMessage({
    type: MESSAGE_TYPES.LOAD_QUEUE,
    payload: {
      queue,
      settings,
      promptFile: { name: currentState?.promptFile?.name || "prompt.txt", content: promptContent, pickedAt: new Date().toISOString() }
    }
  });

  hideValidation();
}

async function sendRunCommand(type) {
  const errors = type === MESSAGE_TYPES.START_RUN ? validateForStart() : [];
  if (errors.length) {
    showValidation(errors);
    return;
  }
  hideValidation();

  if (type === MESSAGE_TYPES.START_RUN) {
    const settings = readSettingsFromForm();
    if (settings.mockMode) {
      const ok = window.confirm("Mock mode đang BẬT. Sẽ KHÔNG gửi sang ChatGPT, chỉ tạo ảnh test cục bộ. Tiếp tục?");
      if (!ok) return;
    } else {
      // Refresh write permission on the output folder while we still have a user gesture.
      await ensureFolderWriteAccess();
    }
    const tab = await pickChatGptTab();
    await sendMessage({ type, tabId: tab?.id });
    return;
  }

  await sendMessage({ type });
}

async function preloadReferenceBlobs(modelFiles, sceneFiles, productFiles) {
  const groups = [
    { role: FOLDER_ROLES.MODEL, files: modelFiles, label: "mẫu" },
    { role: FOLDER_ROLES.SCENE, files: sceneFiles, label: "cảnh" },
    { role: FOLDER_ROLES.PRODUCT, files: productFiles, label: "sản phẩm" }
  ];

  for (const { role, files, label } of groups) {
    const directoryHandle = await getDirectoryHandleByRole(role);
    if (!directoryHandle) {
      throw new Error(`Chưa chọn folder ${label}.`);
    }
    const perm = await directoryHandle.requestPermission({ mode: "read" });
    if (perm !== "granted") {
      throw new Error(`Bị từ chối quyền đọc folder ${label}. Hãy chọn lại.`);
    }
    // Wipe previous cache for this role so renamed/removed files don't linger.
    await clearBlobsForRolePrefix(role).catch(() => null);

    for (const entry of files) {
      try {
        const fileHandle = await resolveFileHandle(directoryHandle, entry.relPath);
        const blob = await fileHandle.getFile();
        await putBlob(blobKey(role, entry.relPath), blob);
      } catch (error) {
        throw new Error(`Lỗi đọc ${label}/${entry.relPath}: ${error.message || error}`);
      }
    }
  }
}

async function ensureFolderWriteAccess() {
  // Refresh permissions for all 4 folders + prompt file under the same user
  // gesture (Start click). Output needs readwrite; the rest only readonly.
  const refreshes = [
    { role: FOLDER_ROLES.OUTPUT, mode: "readwrite", label: "output" },
    { role: FOLDER_ROLES.MODEL, mode: "read", label: "mẫu" },
    { role: FOLDER_ROLES.SCENE, mode: "read", label: "cảnh" },
    { role: FOLDER_ROLES.PRODUCT, mode: "read", label: "sản phẩm" }
  ];

  for (const { role, mode, label } of refreshes) {
    const handle = await getDirectoryHandleByRole(role).catch(() => null);
    if (!handle) {
      throw new Error(`Chưa chọn folder ${label}.`);
    }
    const permission = await handle.requestPermission({ mode });
    if (permission !== "granted") {
      throw new Error(`Bị từ chối quyền với folder ${label}. Hãy chọn lại.`);
    }
  }

  const promptHandle = await getPromptFileHandle().catch(() => null);
  if (promptHandle) {
    const promptPerm = await promptHandle.requestPermission({ mode: "read" });
    if (promptPerm !== "granted") {
      throw new Error("Bị từ chối quyền đọc prompt.txt. Hãy chọn file lại.");
    }
  }

  // Force the offscreen doc to drop any stale handle cache from a prior batch.
  await sendMessage({ type: MESSAGE_TYPES.RESET_OFFSCREEN_HANDLES }).catch(() => null);
}

async function pickChatGptTab() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  if (!tabs.length) {
    throw new Error("Chưa thấy tab ChatGPT. Hãy mở https://chatgpt.com (hoặc ChatGPT Image) trước rồi quay lại.");
  }
  const active = tabs.find((tab) => tab.active);
  return active || tabs[0];
}

// ---------- Settings & validation ----------

function readSettingsFromForm() {
  return {
    prefix: elements.prefixInput.value.trim() || DEFAULT_SETTINGS.prefix,
    aspectRatio: ASPECT_RATIOS.includes(elements.aspectRatioSelect.value)
      ? elements.aspectRatioSelect.value
      : DEFAULT_SETTINGS.aspectRatio,
    delayBetweenJobsMs: clampNumber(elements.delayInput.value, 0, 600000),
    delayJitterMs: DEFAULT_SETTINGS.delayJitterMs,
    maxRetries: clampNumber(elements.retryInput.value, 0, 10),
    resultTimeoutMs: clampNumber(elements.resultTimeoutInput.value, 30000, 3600000),
    uploadTimeoutMs: DEFAULT_SETTINGS.uploadTimeoutMs,
    submitTimeoutMs: DEFAULT_SETTINGS.submitTimeoutMs,
    imageStabilityMs: DEFAULT_SETTINGS.imageStabilityMs,
    filenameMaxLength: DEFAULT_SETTINGS.filenameMaxLength,
    resumeFromLastFailed: elements.resumeFailedCheckbox.checked,
    skipExistingOutput: elements.skipExistingCheckbox.checked,
    includeSubfolders: elements.includeSubfolders.checked,
    overwriteExisting: elements.overwriteCheckbox.checked,
    mockMode: elements.mockModeCheckbox.checked
  };
}

async function persistSettings() {
  const settings = readSettingsFromForm();
  await sendMessage({ type: MESSAGE_TYPES.UPDATE_SETTINGS, settings });
}

function validateForBuild() {
  const errors = [];
  for (const role of ["model", "scene", "product"]) {
    const folder = currentState?.folders?.[role];
    if (!folder) errors.push(`Chưa chọn folder ${roleLabel(role)}.`);
    else if (!folder.count) errors.push(`Folder ${roleLabel(role)} trống (không có ảnh).`);
  }
  if (!currentState?.folders?.output) errors.push("Chưa chọn folder Output.");
  if (!currentState?.promptFile?.content) errors.push("Chưa chọn prompt.txt hoặc file rỗng.");
  return errors;
}

function validateForStart() {
  const errors = validateForBuild();
  if (!currentState?.queue?.length) errors.push("Queue đang trống — bấm Build queue trước.");
  return errors;
}

function showValidation(errors) {
  elements.validationList.innerHTML = `
    <strong>Cần xử lý trước khi chạy:</strong>
    <ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
  `;
  elements.validationList.classList.remove("hidden");
}

function hideValidation() {
  elements.validationList.classList.add("hidden");
}

// ---------- Folder listings rehydration ----------

async function rehydrateFolderListingsFromState() {
  const state = currentState || (await getState());
  for (const role of ["model", "scene", "product"]) {
    if (folderListings[role].length) continue;
    const folder = state?.folders?.[role];
    if (folder?.files?.length) {
      folderListings[role] = folder.files;
    }
  }
}

// ---------- Render ----------

function render(state) {
  const settings = state?.settings || DEFAULT_SETTINGS;

  elements.prefixInput.value = settings.prefix || "";
  elements.aspectRatioSelect.value = settings.aspectRatio || "9:16";
  elements.delayInput.value = String(settings.delayBetweenJobsMs ?? 7000);
  elements.retryInput.value = String(settings.maxRetries ?? 2);
  elements.resultTimeoutInput.value = String(settings.resultTimeoutMs ?? 240000);
  elements.resumeFailedCheckbox.checked = !!settings.resumeFromLastFailed;
  elements.skipExistingCheckbox.checked = !!settings.skipExistingOutput;
  elements.includeSubfolders.checked = !!settings.includeSubfolders;
  elements.overwriteCheckbox.checked = !!settings.overwriteExisting;
  elements.mockModeCheckbox.checked = !!settings.mockMode;
  elements.mockWarning.classList.toggle("hidden", !settings.mockMode);

  for (const role of ["model", "scene", "product", "output"]) {
    const folder = state?.folders?.[role];
    elements.folderLabels[role].textContent = folder?.name || "Chưa chọn";
    if (role === "output") {
      elements.folderCounts[role].textContent = folder ? "Sẵn sàng ghi" : "Nơi lưu ảnh";
    } else {
      elements.folderCounts[role].textContent = `${folder?.count ?? 0} ảnh`;
    }
  }

  elements.promptFileLabel.textContent = state?.promptFile?.name || "Chưa chọn";
  if (state?.promptFile?.content) {
    const promptCount = splitPrompts(state.promptFile.content, "===").length;
    elements.promptFileMeta.textContent = `${promptCount} prompt${promptCount > 1 ? "s" : ""} · ${state.promptFile.content.length} ký tự`;
  } else {
    elements.promptFileMeta.textContent = "Template (cách nhau bằng === nếu nhiều prompt)";
  }

  const queueLength = state?.queue?.length || 0;
  elements.jobCount.textContent = `${queueLength} jobs`;
  elements.runStateBadge.textContent = state?.runState?.status || RUN_STATUS.IDLE;

  // Stats
  const stats = state?.stats || {};
  elements.statTotal.textContent = stats.total ?? queueLength;
  elements.statDone.textContent = stats.done ?? 0;
  elements.statRunning.textContent = stats.running ?? 0;
  elements.statFailed.textContent = stats.failed ?? 0;
  elements.statSkipped.textContent = stats.skipped ?? 0;
  elements.statPending.textContent = stats.pending ?? 0;

  const resolved = (stats.done || 0) + (stats.skipped || 0) + (stats.failed || 0);
  const pct = stats.total ? Math.round((resolved / stats.total) * 100) : 0;
  elements.progressBar.style.width = `${pct}%`;

  // Current job
  const currentIdx = state?.currentIndex ?? -1;
  const current = currentIdx >= 0 ? state?.queue?.[currentIdx] : null;
  elements.currentJobSummary.innerHTML = current
    ? `<strong>#${current.index}/${current.total}</strong> · model:<em>${escapeHtml(current.modelFile?.name || "")}</em> · scene:<em>${escapeHtml(current.sceneFile?.name || "")}</em> · product:<em>${escapeHtml(current.productFile?.name || "")}</em>`
    : "—";

  elements.timeStarted.textContent = formatTime(state?.runState?.startedAt);
  elements.timeFinished.textContent = formatTime(state?.runState?.finishedAt);

  elements.queueList.innerHTML = renderQueue(state?.queue || []);
  elements.logList.innerHTML = renderLogs(state?.logs || []);
}

function renderQueue(queue) {
  if (!queue.length) return `<div class="queue-item"><p>Chưa có job nào.</p></div>`;
  // Show first 5 + last 1 to keep popup compact.
  const head = queue.slice(0, 5);
  const tail = queue.length > 6 ? queue.slice(-1) : [];
  const items = [...head, ...(queue.length > 6 ? [{ separator: true, count: queue.length - 6 }] : []), ...tail];
  return items.map((item) => {
    if (item.separator) {
      return `<div class="queue-item"><p>… ${item.count} job khác …</p></div>`;
    }
    const promptTag = item.promptTotal && item.promptTotal > 1
      ? ` · prompt ${item.promptIndex}/${item.promptTotal}`
      : "";
    return `
      <article class="queue-item">
        <header>
          <strong>#${item.index}/${item.total}${promptTag}</strong>
          <span class="status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
        </header>
        <p>${escapeHtml(item.modelFile?.name || "")} × ${escapeHtml(item.sceneFile?.name || "")} × ${escapeHtml(item.productFile?.name || "")}</p>
        <p>${escapeHtml(item.outputFilename || "")}</p>
        ${item.errorMessage ? `<p class="status-failed">${escapeHtml(item.errorMessage)}</p>` : ""}
      </article>
    `;
  }).join("");
}

function renderLogs(logs) {
  if (!logs.length) return `<div class="log-item"><p>Chưa có log.</p></div>`;
  return logs.slice().reverse().slice(0, 80).map((log) => {
    const level = escapeHtml(log.level || "info");
    return `
      <article class="log-item level-${level}">
        <header>
          <strong>${level}</strong>
          <span>${escapeHtml(new Date(log.timestamp).toLocaleTimeString())}</span>
        </header>
        <p>${escapeHtml(log.message || "")}</p>
      </article>
    `;
  }).join("");
}

// ---------- Export ----------

async function exportJson() {
  const state = await getState();
  downloadTextAsFile(buildJsonExport(state), `fashion-batch-${stamp()}.json`, "application/json");
}

async function exportCsv() {
  const state = await getState();
  downloadTextAsFile(buildCsvExport(state), `fashion-batch-${stamp()}.csv`, "text/csv");
}

function stamp() {
  return new Date().toISOString().replace(/[:T.]/g, "-").replace(/Z$/, "");
}

// ---------- Helpers ----------

async function getState() {
  const response = await sendMessage({ type: MESSAGE_TYPES.GET_STATE });
  return response.state;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Action failed."));
        return;
      }
      resolve(response);
    });
  });
}

async function withErrors(fn) {
  try {
    await fn();
  } catch (error) {
    await sendMessage({
      type: MESSAGE_TYPES.APPEND_LOG,
      level: "error",
      message: error.message || "Lỗi không xác định."
    }).catch(() => null);
    showValidation([error.message || "Lỗi không xác định."]);
  }
}

function clampNumber(value, min, max) {
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function roleLabel(role) {
  if (role === "model") return "mẫu";
  if (role === "scene") return "cảnh";
  if (role === "product") return "sản phẩm";
  if (role === "output") return "output";
  return role;
}

function formatTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString(); } catch (_e) { return "—"; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showFatalError(error) {
  elements.logList.innerHTML = `<div class="log-item level-error"><p>${escapeHtml(error.message || "Popup init failed.")}</p></div>`;
}
