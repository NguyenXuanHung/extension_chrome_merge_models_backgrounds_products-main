// Content-script-side automation toolkit. Exposes window.ChatGPTAutomation
// with helpers for: detecting the composer / file input / submit button,
// uploading 3 images per job, pasting the prompt, submitting, waiting for the
// result image and downloading its bytes. content.js orchestrates these.
//
// Most of the composer/submit logic was carried over from the previous version
// of content.js — kept intact because it has been tuned against the live UI.

(function attachAutomation() {
  if (window.ChatGPTAutomation) {
    return;
  }

  // ---------- Selector helpers (with optional user overrides) ----------

  let cachedOverrides = null;

  async function loadSelectorOverrides() {
    if (cachedOverrides !== null) return cachedOverrides;
    try {
      const result = await chrome.storage.local.get("selectorOverrides");
      cachedOverrides = result.selectorOverrides || {};
    } catch (error) {
      cachedOverrides = {};
    }
    return cachedOverrides;
  }

  // Re-read overrides whenever the user saves new ones from the Options page.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.selectorOverrides) {
      cachedOverrides = changes.selectorOverrides.newValue || {};
    }
  });

  function getSelectors(key) {
    const base = window.ChatGPTImageSelectors?.[key] || [];
    const override = cachedOverrides?.[key];
    if (Array.isArray(override) && override.length) return override;
    if (typeof override === "string" && override.trim()) {
      return override.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    return base;
  }

  // ---------- Composer detection ----------

  function findComposer() {
    const allCandidates = [];
    for (const selector of getSelectors("composerTargets")) {
      const nodes = Array.from(document.querySelectorAll(selector));
      allCandidates.push(...nodes);
      const match = nodes.find((node) => isLikelyComposer(node));
      if (match) return match;
    }
    return [...new Set(allCandidates)].find((node) => isFallbackComposer(node)) || null;
  }

  function isLikelyComposer(node) {
    if (!(node instanceof HTMLElement)) return false;
    const hint = collectComposerHint(node);
    const matchesHint = (window.ChatGPTImageSelectors?.textHints || [])
      .some((text) => hint.includes(text));
    const editable = isEditableNode(node);
    const visible = isVisible(node) || hasVisibleAncestor(node);

    if (node instanceof HTMLTextAreaElement) {
      return isVisible(node) && !node.disabled && !node.readOnly;
    }
    return editable && visible && matchesHint;
  }

  function isFallbackComposer(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (!isEditableNode(node)) return false;
    if (node instanceof HTMLTextAreaElement && !isVisible(node)) return false;
    const visible = isVisible(node) || hasVisibleAncestor(node);
    const rect = node.getBoundingClientRect();
    return visible && rect.width >= 100;
  }

  // ---------- Submit button detection ----------

  function findSubmitButton() {
    const seen = new Set();
    for (const selector of getSelectors("submitTargets")) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (!isUsableButton(node)) continue;

        const label = buttonLabel(node);
        const passesHint = !window.ChatGPTImageSelectors?.buttonHints?.length
          || window.ChatGPTImageSelectors.buttonHints.some((text) => label.includes(text))
          || selector === "form button[type='submit']"
          || node.getAttribute("data-testid")?.toLowerCase().includes("send");
        if (passesHint) return node;
      }
    }

    // Fallback: rightmost enabled non-mic button inside the composer's form.
    const composer = findComposer();
    const form = composer?.closest("form");
    if (form) {
      const candidates = Array.from(form.querySelectorAll("button")).filter(isUsableButton);
      if (candidates.length) {
        candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return candidates[0];
      }
    }
    return null;
  }

  function findStopButton() {
    for (const node of document.querySelectorAll("button")) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.disabled || node.getAttribute("aria-disabled") === "true") continue;
      if (!isVisible(node)) continue;
      if (isStopOrAbortButton(node)) return node;
    }
    return null;
  }

  // ---------- File input / upload area ----------

  function findFileInput() {
    for (const selector of getSelectors("fileInputTargets")) {
      const nodes = Array.from(document.querySelectorAll(selector))
        .filter((node) => node instanceof HTMLInputElement && node.type === "file");
      if (nodes.length) {
        // Prefer the input that accepts images.
        const accepting = nodes.find((node) => (node.accept || "").includes("image"));
        return accepting || nodes[0];
      }
    }
    return null;
  }

  function findUploadDropZone() {
    for (const selector of getSelectors("uploadAreaTargets")) {
      const node = document.querySelector(selector);
      if (node && isVisible(node)) return node;
    }
    return findComposer();
  }

  // ---------- Image upload ----------

  // Accepts an array of File objects. Tries the file input path first because
  // it is the most reliable; falls back to a synthesized drag/drop sequence.
  async function uploadFiles(files) {
    if (!files?.length) return;

    const fileInput = findFileInput();
    if (fileInput) {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const target = findUploadDropZone();
    if (!target) {
      throw new Error("Không tìm thấy vùng upload ảnh trên ChatGPT.");
    }

    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));

    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer: dt
    };
    target.dispatchEvent(new DragEvent("dragenter", eventInit));
    target.dispatchEvent(new DragEvent("dragover", eventInit));
    target.dispatchEvent(new DragEvent("drop", eventInit));
  }

  // Counts attachments bound to the composer. Tries 3 signals in order and
  // returns the largest count any of them sees — safest because ChatGPT's
  // markup varies and one selector may miss while another matches.
  function countUploadAttachments() {
    return Math.max(
      countSelectorMatches("uploadTileTargets"),
      countUploadThumbnails(),
      countSelectorMatches("uploadRemoveButtonTargets")
    );
  }

  function countUploadThumbnails() {
    const seen = new Set();
    for (const selector of getSelectors("uploadThumbTargets")) {
      for (const node of document.querySelectorAll(selector)) {
        if (!(node instanceof HTMLElement)) continue;
        if (!isVisible(node)) continue;
        const key = node instanceof HTMLImageElement
          ? (node.currentSrc || node.src)
          : node.getAttribute("data-testid") + "::" + node.outerHTML.length;
        if (key) seen.add(key);
      }
    }
    return seen.size;
  }

  function countSelectorMatches(key) {
    const seen = new Set();
    for (const selector of getSelectors(key)) {
      for (const node of document.querySelectorAll(selector)) {
        if (!(node instanceof HTMLElement)) continue;
        if (!isVisible(node)) continue;
        seen.add(node);
      }
    }
    return seen.size;
  }

  // Click every visible attachment "Remove" button in the composer. Used to
  // clear leftovers from a previous job before we attach the new triple.
  async function clearAllAttachments(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const buttons = [];
      const seen = new Set();
      for (const selector of getSelectors("uploadRemoveButtonTargets")) {
        for (const node of document.querySelectorAll(selector)) {
          if (!(node instanceof HTMLElement)) continue;
          if (!isVisible(node)) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          buttons.push(node);
        }
      }
      if (!buttons.length) return;
      buttons.forEach((btn) => { try { btn.click(); } catch (_e) {} });
      await sleep(250);
    }
  }

  // Counts attachments whose <img src> already points at ChatGPT's backend
  // (not blob:). This is the only reliable "server-side upload finished"
  // signal — clicking submit before this lands silently fails.
  function countServerUploadedAttachments() {
    const prefixes = window.ChatGPTImageSelectors?.uploadedImageUrlPrefixes || [];
    if (!prefixes.length) return 0;
    const seen = new Set();
    // Walk every <img> inside attachment tiles or the composer form.
    const candidates = [];
    for (const sel of getSelectors("uploadTileTargets")) {
      document.querySelectorAll(sel).forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        node.querySelectorAll("img").forEach((img) => candidates.push(img));
      });
    }
    // Also pick up images inside the composer form.
    const form = findComposer()?.closest("form");
    if (form) form.querySelectorAll("img").forEach((img) => candidates.push(img));

    for (const img of candidates) {
      if (!(img instanceof HTMLImageElement)) continue;
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      if (prefixes.some((p) => src.startsWith(p))) seen.add(src);
    }
    return seen.size;
  }

  async function waitForServerUpload(expectedDelta, baseline, timeoutMs) {
    const target = baseline + expectedDelta;
    return waitFor(
      () => countServerUploadedAttachments() >= target,
      timeoutMs,
      500,
      `Upload server chưa xong (mới: ${countServerUploadedAttachments() - baseline}/${expectedDelta}).`
    );
  }

  // Wait until `expectedDelta` NEW attachments appear beyond the baseline.
  // If our count selectors see 0 the whole time (markup mismatch), fall back
  // to a fixed wait so the rest of the pipeline can still proceed — the user
  // can verify visually and our submit step has its own checks.
  async function waitForUploadComplete(expectedDelta, baseline, timeoutMs, stabilityMs = 1500) {
    const target = baseline + expectedDelta;
    const fallbackAfter = Math.min(timeoutMs, 8000); // fall back after 8s if count still 0
    const started = Date.now();
    let everCounted = false;

    while (Date.now() - started < timeoutMs) {
      const count = countUploadAttachments();
      if (count > 0) everCounted = true;
      if (count >= target) break;
      // Fallback: if no selector ever produced a count, just wait fallbackAfter
      // and trust that the upload happened. Better than blocking forever.
      if (!everCounted && Date.now() - started > fallbackAfter) {
        await sleep(stabilityMs);
        return;
      }
      await sleep(400);
    }

    // Stability window: the count must hold steady for stabilityMs. If a new
    // thumbnail arrives during the wait we reset the timer.
    let stableSince = Date.now();
    let lastCount = countUploadAttachments();
    while (Date.now() - stableSince < stabilityMs) {
      await sleep(200);
      const now = countUploadAttachments();
      if (now !== lastCount) {
        lastCount = now;
        stableSince = Date.now();
      }
    }

    // Best-effort: wait for blob:url thumbnails to finish decoding. Time-bounded
    // so a stuck thumb doesn't block forever.
    try {
      await waitFor(
        () => allBlobThumbsLoaded(),
        Math.max(2000, stabilityMs * 2),
        300,
        "Có thumbnail upload chưa load xong."
      );
    } catch (_e) {
      // Non-fatal — let submit proceed, retry will catch real failures.
    }
  }

  function allBlobThumbsLoaded() {
    const imgs = [];
    for (const selector of getSelectors("uploadThumbTargets")) {
      for (const node of document.querySelectorAll(selector)) {
        if (node instanceof HTMLImageElement && isVisible(node)) imgs.push(node);
      }
    }
    if (!imgs.length) return true; // nothing to wait on
    return imgs.every((img) => img.complete && img.naturalWidth > 0);
  }

  async function waitForChatGPTIdle(timeoutMs) {
    try {
      await waitFor(() => !findStopButton(), timeoutMs, 500, "ChatGPT chưa rảnh để nhận job mới.");
    } catch (_error) {
      // Non-fatal; later submit-verification step will catch a real deadlock.
    }
  }

  async function waitForSubmissionStart(composer, prompt, timeoutMs = 15000) {
    return waitFor(
      () => findStopButton() || !composerContainsText(composer, prompt),
      timeoutMs,
      250,
      "Đã paste prompt nhưng ChatGPT không bắt đầu generate."
    );
  }

  async function waitForGenerationDone(timeoutMs) {
    if (!findStopButton()) return;
    await waitFor(
      () => !findStopButton(),
      timeoutMs,
      1000,
      "ChatGPT chưa hoàn tất trong khoảng timeout."
    );
  }

  // ---------- Result image ----------

  function snapshotImageSources() {
    return new Set(collectResultImages().map((img) => img.currentSrc || img.src).filter(Boolean));
  }

  function collectResultImages() {
    const nodes = [];
    for (const selector of getSelectors("resultImageTargets")) {
      document.querySelectorAll(selector).forEach((node) => nodes.push(node));
    }
    return [...new Set(nodes)].filter((node) => node instanceof HTMLImageElement && isVisible(node));
  }

  async function waitForNewImage(beforeSet, options) {
    const timeoutMs = Number(options?.resultTimeoutMs || 240000);
    const stabilityMs = Number(options?.imageStabilityMs || 2500);
    const minDimension = 200;
    const shouldStop = options?.shouldStop || (() => false);

    const started = Date.now();
    let candidate = null;
    let candidateSrc = null;
    let stableSince = 0;

    while (true) {
      if (shouldStop()) {
        throw new Error("Runner đã bị stop.");
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error("Không phát hiện ảnh kết quả ổn định trong thời gian chờ.");
      }
      const best = collectResultImages()
        .filter((img) => {
          const src = img.currentSrc || img.src;
          if (!src || beforeSet.has(src)) return false;
          if (!img.complete || img.naturalWidth < minDimension || img.naturalHeight < minDimension) return false;
          return true;
        })
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0] || null;

      if (best) {
        const bestSrc = best.currentSrc || best.src;
        if (candidate === best && candidateSrc === bestSrc) {
          if (Date.now() - stableSince >= stabilityMs) return best;
        } else {
          candidate = best;
          candidateSrc = bestSrc;
          stableSince = Date.now();
        }
      }
      await sleep(750);
    }
  }

  async function fetchImageBytes(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Tải ảnh kết quả thất bại (HTTP ${response.status}).`);
    }
    return response.arrayBuffer();
  }

  // ---------- Composer text ----------

  async function setComposerValue(node, value) {
    node.scrollIntoView({ block: "center", inline: "nearest" });
    node.focus();

    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const prototype = Object.getPrototypeOf(node);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      descriptor?.set?.call(node, "");
      descriptor?.set?.call(node, value);
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    selectAllContent(node);
    document.execCommand("delete", false);

    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", value);
    node.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    }));

    if (!composerContainsText(node, value)) {
      selectAllContent(node);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, value);
    }

    if (!composerContainsText(node, value)) {
      node.innerHTML = "";
      const paragraph = document.createElement("p");
      paragraph.textContent = value;
      node.appendChild(paragraph);
      node.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }

    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
    node.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "End" }));
    await sleep(300);
  }

  // Some apps only react to a full pointer/mouse event chain (ignoring a bare
  // `.click()` because isTrusted=false). Fires pointerdown → mousedown →
  // pointerup → mouseup → click in sequence.
  function robustClick(node) {
    if (!(node instanceof HTMLElement)) return false;
    try { node.scrollIntoView({ block: "nearest" }); } catch (_e) {}
    const rect = node.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    try { node.dispatchEvent(new PointerEvent("pointerover", init)); } catch (_e) {}
    try { node.dispatchEvent(new MouseEvent("mouseover", init)); } catch (_e) {}
    try { node.dispatchEvent(new PointerEvent("pointerdown", init)); } catch (_e) {}
    try { node.dispatchEvent(new MouseEvent("mousedown", init)); } catch (_e) {}
    try { node.focus?.(); } catch (_e) {}
    try { node.dispatchEvent(new PointerEvent("pointerup", init)); } catch (_e) {}
    try { node.dispatchEvent(new MouseEvent("mouseup", init)); } catch (_e) {}
    try { node.click(); } catch (_e) {}
    return true;
  }

  function pressEnterOn(node) {
    node.focus?.();
    const base = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    node.dispatchEvent(new KeyboardEvent("keydown", base));
    node.dispatchEvent(new KeyboardEvent("keypress", base));
    node.dispatchEvent(new KeyboardEvent("keyup", base));
  }

  function selectAllContent(node) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function composerContainsText(node, value) {
    const body = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const needle = value.replace(/\s+/g, " ").trim();
    if (!needle) return true;
    const prefix = needle.slice(0, Math.min(40, needle.length));
    return body.includes(prefix);
  }

  // ---------- Predicates ----------

  function isUsableButton(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.disabled || node.getAttribute("aria-disabled") === "true") return false;
    if (isVoiceOrMicButton(node)) return false;
    if (isStopOrAbortButton(node)) return false;
    return isVisible(node);
  }

  function isVoiceOrMicButton(node) {
    const label = buttonLabel(node);
    if (/\b(voice|dictat|microphone|speech|speak|record|ghi âm|giọng nói)\b/.test(label)) return true;
    if (/\bmic\b/.test(label)) return true;
    if (/composer-speech-button/.test(label)) return true;
    const testid = (node.getAttribute("data-testid") || "").toLowerCase();
    if (testid.includes("speech") || testid.includes("voice") || testid.includes("mic")) return true;
    return false;
  }

  function isStopOrAbortButton(node) {
    const label = buttonLabel(node);
    if (/\b(stop|halt|abort|cancel|streaming)\b/.test(label)) return true;
    const testid = (node.getAttribute("data-testid") || "").toLowerCase();
    if (testid.includes("stop") || testid.includes("abort")) return true;
    return false;
  }

  function buttonLabel(node) {
    return [node.getAttribute("aria-label"), node.textContent, node.title, node.getAttribute("data-testid")]
      .filter(Boolean).join(" ").toLowerCase();
  }

  function collectComposerHint(node) {
    return [
      node.getAttribute("aria-label"),
      node.getAttribute("placeholder"),
      node.getAttribute("data-placeholder"),
      node.getAttribute("title"),
      node.textContent,
      node.closest("form")?.textContent
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function isEditableNode(node) {
    return node instanceof HTMLTextAreaElement
      || node instanceof HTMLInputElement
      || node.isContentEditable
      || node.getAttribute("contenteditable") === "true";
  }

  function hasVisibleAncestor(node) {
    let current = node.parentElement;
    while (current) {
      if (isVisible(current)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  // ---------- Generic helpers ----------

  function waitFor(predicate, timeoutMs, intervalMs = 250, timeoutMessage = "Timed out.") {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const intervalId = window.setInterval(() => {
        try {
          const result = predicate();
          if (result) {
            clearInterval(intervalId);
            resolve(result);
            return;
          }
        } catch (error) {
          clearInterval(intervalId);
          reject(error);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(intervalId);
          reject(new Error(timeoutMessage));
        }
      }, intervalMs);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || "application/octet-stream" });
  }

  // ---------- Public API ----------

  window.ChatGPTAutomation = {
    loadSelectorOverrides,
    findComposer,
    findSubmitButton,
    findStopButton,
    findFileInput,
    findUploadDropZone,
    uploadFiles,
    countUploadThumbnails,
    countUploadAttachments,
    countServerUploadedAttachments,
    waitForServerUpload,
    clearAllAttachments,
    waitForUploadComplete,
    robustClick,
    waitForChatGPTIdle,
    waitForSubmissionStart,
    waitForGenerationDone,
    snapshotImageSources,
    collectResultImages,
    waitForNewImage,
    fetchImageBytes,
    setComposerValue,
    composerContainsText,
    pressEnterOn,
    isUsableButton,
    isVoiceOrMicButton,
    isStopOrAbortButton,
    arrayBufferToBase64,
    base64ToBlob,
    waitFor,
    sleep
  };
})();
