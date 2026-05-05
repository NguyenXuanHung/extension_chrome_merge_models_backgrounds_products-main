// chrome.storage.local wrapper. Hydrates state with defaults so callers never
// have to deal with partial / missing fields. Replaces the older state.js.

import { DEFAULT_STATE, LOG_LIMIT, STORAGE_KEYS } from "./config.js";

export async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.APP_STATE);
  return hydrateState(stored[STORAGE_KEYS.APP_STATE] || {});
}

export async function setState(nextState) {
  const hydrated = hydrateState(nextState);
  await chrome.storage.local.set({ [STORAGE_KEYS.APP_STATE]: hydrated });
  return hydrated;
}

export async function patchState(patch = {}) {
  const current = await getState();
  const merged = hydrateState({
    ...current,
    ...patch,
    folders: { ...current.folders, ...(patch.folders || {}) },
    settings: { ...current.settings, ...(patch.settings || {}) },
    runState: { ...current.runState, ...(patch.runState || {}) },
    stats: { ...current.stats, ...(patch.stats || {}) }
  });
  await setState(merged);
  return merged;
}

export async function appendLog(message, level = "info", extra = {}) {
  const state = await getState();
  const logs = [
    ...state.logs,
    {
      id: crypto.randomUUID(),
      level,
      message,
      timestamp: new Date().toISOString(),
      ...extra
    }
  ].slice(-LOG_LIMIT);
  return setState({ ...state, logs });
}

export async function clearLogs() {
  return patchState({ logs: [] });
}

export async function getSelectorOverrides() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SELECTOR_OVERRIDES);
  return stored[STORAGE_KEYS.SELECTOR_OVERRIDES] || null;
}

export async function setSelectorOverrides(overrides) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SELECTOR_OVERRIDES]: overrides || null });
  return overrides;
}

export function recomputeStats(queue) {
  const stats = { total: queue.length, done: 0, running: 0, failed: 0, skipped: 0, pending: 0 };
  for (const item of queue) {
    if (item.status === "done") stats.done++;
    else if (item.status === "running") stats.running++;
    else if (item.status === "failed") stats.failed++;
    else if (item.status === "skipped") stats.skipped++;
    else stats.pending++;
  }
  return stats;
}

function hydrateState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    folders: { ...DEFAULT_STATE.folders, ...(state.folders || {}) },
    settings: { ...DEFAULT_STATE.settings, ...(state.settings || {}) },
    runState: { ...DEFAULT_STATE.runState, ...(state.runState || {}) },
    stats: { ...DEFAULT_STATE.stats, ...(state.stats || {}) },
    queue: Array.isArray(state.queue) ? state.queue : [],
    logs: Array.isArray(state.logs) ? state.logs : []
  };
}
