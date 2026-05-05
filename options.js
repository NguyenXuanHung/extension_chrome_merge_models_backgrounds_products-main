// Options page. Lets the user override per-key selector lists for cases where
// ChatGPT changes its DOM. Includes a "Test Detect" that asks the active
// ChatGPT tab whether the current selectors find the composer / submit / etc.

import { MESSAGE_TYPES } from "./lib/config.js";
import { getSelectorOverrides, setSelectorOverrides } from "./lib/storage.js";

const KEYS = [
  "composerTargets",
  "fileInputTargets",
  "uploadAreaTargets",
  "submitTargets",
  "resultImageTargets",
  "uploadThumbTargets",
  "generatingTargets"
];

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries(KEYS.map((key) => [key, $(key)]));
elements.saveBtn = $("save-btn");
elements.resetBtn = $("reset-btn");
elements.testBtn = $("test-detect-btn");
elements.backBtn = $("back-btn");
elements.testResults = $("test-results");

let defaults = {};

bootstrap().catch((err) => alert(err.message));

async function bootstrap() {
  defaults = await fetchDefaults();
  const overrides = (await getSelectorOverrides()) || {};
  for (const key of KEYS) {
    const value = Array.isArray(overrides[key]) ? overrides[key].join("\n")
                : typeof overrides[key] === "string" ? overrides[key]
                : (defaults[key] || []).join("\n");
    elements[key].value = value;
  }

  elements.saveBtn.addEventListener("click", saveOverrides);
  elements.resetBtn.addEventListener("click", resetDefaults);
  elements.testBtn.addEventListener("click", runTestDetect);
  elements.backBtn.addEventListener("click", () => window.close());
}

// Pull defaults by importing the same selectors.js script in an isolated probe.
// Easier: hard-code mirror of the defaults below — kept minimal because the
// real defaults live in selectors.js and are loaded inside the content script.
async function fetchDefaults() {
  // Fetch and eval selectors.js content to read its default object without
  // needing to ship a separate JSON file.
  const url = chrome.runtime.getURL("selectors.js");
  const text = await fetch(url).then((r) => r.text());
  const sandbox = { window: {}, ChatGPTImageSelectors: null };
  // Evaluate inside a Function so we don't pollute the page globals.
  try {
    const fn = new Function("window", `${text}\nreturn window.ChatGPTImageSelectors;`);
    const result = fn(sandbox.window) || sandbox.window.ChatGPTImageSelectors;
    return result || {};
  } catch (_error) {
    return {};
  }
}

async function saveOverrides() {
  const overrides = {};
  for (const key of KEYS) {
    const lines = elements[key].value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length) overrides[key] = lines;
  }
  await setSelectorOverrides(overrides);
  flash(elements.saveBtn, "Đã lưu");
}

async function resetDefaults() {
  await setSelectorOverrides({});
  for (const key of KEYS) {
    elements[key].value = (defaults[key] || []).join("\n");
  }
  flash(elements.resetBtn, "Đã reset");
}

async function runTestDetect() {
  // Save first so the active tab uses the current overrides during the test.
  await saveOverrides();
  elements.testResults.innerHTML = `<div class="test-item">Đang test trên tab ChatGPT…</div>`;

  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  if (!tabs.length) {
    elements.testResults.innerHTML = `<div class="test-item bad">Không thấy tab ChatGPT nào đang mở.</div>`;
    return;
  }
  const tab = tabs.find((t) => t.active) || tabs[0];

  try {
    // Ensure content script is alive.
    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.PING }).catch(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["selectors.js", "chatgptAutomation.js", "content.js"]
      });
    });

    const response = await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.TEST_DETECT });
    if (!response?.ok) {
      elements.testResults.innerHTML = `<div class="test-item bad">${response?.error || "Test thất bại."}</div>`;
      return;
    }
    const d = response.detection || {};
    elements.testResults.innerHTML = `
      ${row("Composer", d.composer, d.composerDescription)}
      ${row("File input", d.fileInput, d.fileInputDescription)}
      ${row("Submit button", d.submit, d.submitDescription)}
      ${row("Stop button visible", d.stopVisible, d.stopVisible ? "ChatGPT đang generate" : "Idle")}
      ${row("Upload thumbnails", true, `Đang đếm: ${d.thumbCount}`)}
    `;
  } catch (error) {
    elements.testResults.innerHTML = `<div class="test-item bad">${error.message}</div>`;
  }
}

function row(label, ok, detail) {
  const cls = ok ? "ok" : "bad";
  const symbol = ok ? "✓" : "✗";
  return `<div class="test-item ${cls}"><strong>${symbol} ${label}</strong><span>${detail || (ok ? "Found" : "Not found")}</span></div>`;
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1200);
}
