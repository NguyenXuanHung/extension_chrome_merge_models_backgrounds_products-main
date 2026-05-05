// Logger and log-export helpers. Storage backed (chrome.storage via storage.js).
// Exports both a CSV and JSON view of the queue + log feed for the user to keep
// after a long batch.

import { appendLog } from "./storage.js";

export async function logInfo(message, extra) {
  return appendLog(message, "info", extra || {});
}

export async function logWarn(message, extra) {
  return appendLog(message, "warn", extra || {});
}

export async function logError(message, extra) {
  return appendLog(message, "error", extra || {});
}

export function buildJsonExport(state) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runState: state.runState,
      stats: state.stats,
      settings: state.settings,
      folders: state.folders,
      promptFile: state.promptFile,
      queue: state.queue,
      logs: state.logs
    },
    null,
    2
  );
}

export function buildCsvExport(state) {
  const headers = [
    "index",
    "status",
    "retryCount",
    "modelFile",
    "sceneFile",
    "productFile",
    "outputFile",
    "startedAt",
    "finishedAt",
    "errorMessage"
  ];

  const rows = (state.queue || []).map((job) => [
    job.index,
    job.status,
    job.retryCount,
    job.modelFile?.name || "",
    job.sceneFile?.name || "",
    job.productFile?.name || "",
    job.outputFilename || "",
    job.startedAt || "",
    job.finishedAt || "",
    job.errorMessage || ""
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function downloadTextAsFile(text, filename, mimeType = "text/plain") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
