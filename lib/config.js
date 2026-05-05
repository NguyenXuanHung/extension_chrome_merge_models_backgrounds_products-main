// Central config: keys, defaults, message types. Imported by popup, background,
// offscreen, options. Content script keeps a parallel const block (it can't use
// ES modules from manifest content_scripts) — keep them in sync.

export const STORAGE_KEYS = {
  APP_STATE: "appState",
  SELECTOR_OVERRIDES: "selectorOverrides"
};

// Roles double as IndexedDB keys for the FileSystem*Handle objects.
export const HANDLE_KEYS = {
  MODEL_DIR: "modelDir",
  SCENE_DIR: "sceneDir",
  PRODUCT_DIR: "productDir",
  OUTPUT_DIR: "outputDir",
  PROMPT_FILE: "promptFile"
};

export const FOLDER_ROLES = {
  MODEL: "model",
  SCENE: "scene",
  PRODUCT: "product",
  OUTPUT: "output"
};

// Maps folder role → IDB handle key. Single source of truth.
export const ROLE_TO_HANDLE = {
  model: HANDLE_KEYS.MODEL_DIR,
  scene: HANDLE_KEYS.SCENE_DIR,
  product: HANDLE_KEYS.PRODUCT_DIR,
  output: HANDLE_KEYS.OUTPUT_DIR
};

export const ASPECT_RATIOS = ["9:16", "1:1", "4:5", "16:9"];

export const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export const DEFAULT_SETTINGS = {
  prefix: "fashion",
  aspectRatio: "9:16",
  // Spec says default 5–10s. Use 7s mid-range plus jitter ±2s.
  delayBetweenJobsMs: 7000,
  delayJitterMs: 2000,
  maxRetries: 2,
  resumeFromLastFailed: true,
  skipExistingOutput: true,
  includeSubfolders: false,
  overwriteExisting: false,
  mockMode: false,
  resultTimeoutMs: 240000,
  uploadTimeoutMs: 120000,
  submitTimeoutMs: 20000,
  imageStabilityMs: 2500,
  filenameMaxLength: 180
};

export const DEFAULT_STATE = {
  selectedTabId: null,
  folders: {
    model: null,    // { name, count, files: [{ name, relPath }] }
    scene: null,
    product: null,
    output: null    // { name }
  },
  promptFile: null, // { name, content }
  queue: [],
  currentIndex: -1,
  runState: {
    status: "idle",
    lastUpdatedAt: null,
    startedAt: null,
    finishedAt: null
  },
  stats: {
    total: 0,
    done: 0,
    running: 0,
    failed: 0,
    skipped: 0,
    pending: 0
  },
  settings: { ...DEFAULT_SETTINGS },
  logs: []
};

export const STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped"
};

export const RUN_STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  COMPLETED: "completed"
};

export const MESSAGE_TYPES = {
  GET_STATE: "get-state",
  UPDATE_SETTINGS: "update-settings",
  SET_FOLDER_META: "set-folder-meta",
  SET_PROMPT_FILE: "set-prompt-file",
  LOAD_QUEUE: "load-queue",
  CLEAR_QUEUE: "clear-queue",
  START_RUN: "start-run",
  PAUSE_RUN: "pause-run",
  RESUME_RUN: "resume-run",
  STOP_RUN: "stop-run",
  RETRY_FAILED: "retry-failed",
  UPDATE_QUEUE_ITEM: "update-queue-item",
  APPEND_LOG: "append-log",
  CLEAR_LOGS: "clear-logs",
  CONTENT_STATUS: "content-status",
  REQUEST_JOB_FILES: "request-job-files",
  SAVE_IMAGE: "save-image",
  CHECK_OUTPUT_EXISTS: "check-output-exists",
  RESET_OFFSCREEN_HANDLES: "reset-offscreen-handles",
  TEST_DETECT: "test-detect",
  PING: "ping"
};

export const OFFSCREEN_MESSAGE_TYPES = {
  READ_FILE: "read-file",
  SAVE_IMAGE: "save-image",
  CHECK_EXISTS: "check-exists",
  RESET_HANDLES: "reset-handles",
  PROBE: "probe"
};

export const OFFSCREEN_TARGET = "offscreen";

export const LOG_LIMIT = 500;
