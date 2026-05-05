// Main content script: drives one job at a time on whatever ChatGPT tab is
// currently active. State lives in chrome.storage and is owned by the SW; this
// script polls for the next pending job and processes it. Uses ChatGPTAutomation
// (see chatgptAutomation.js) for all DOM interaction.

(function initContentRunner() {
  if (window.__fashionImageRunnerInitialized) {
    return;
  }
  window.__fashionImageRunnerInitialized = true;

  // Mirror lib/config.js — content scripts can't import ES modules directly.
  const MESSAGE_TYPES = {
    GET_STATE: "get-state",
    UPDATE_QUEUE_ITEM: "update-queue-item",
    APPEND_LOG: "append-log",
    CONTENT_STATUS: "content-status",
    REQUEST_JOB_FILES: "request-job-files",
    SAVE_IMAGE: "save-image",
    CHECK_OUTPUT_EXISTS: "check-output-exists",
    START_RUN: "start-run",
    PAUSE_RUN: "pause-run",
    RESUME_RUN: "resume-run",
    STOP_RUN: "stop-run",
    PING: "ping",
    TEST_DETECT: "test-detect"
  };

  const STATUS = {
    PENDING: "pending",
    RUNNING: "running",
    DONE: "done",
    FAILED: "failed",
    SKIPPED: "skipped"
  };

  const RUN_STATUS = {
    RUNNING: "running",
    PAUSED: "paused",
    STOPPED: "stopped",
    COMPLETED: "completed"
  };

  const runner = {
    isRunning: false,
    isPaused: false,
    shouldStop: false,
    startedAt: null
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
    return true;
  });

  async function handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.START_RUN:
        queueMicrotask(() => startRunner().catch(swallowRunnerError));
        return { accepted: true };
      case MESSAGE_TYPES.PAUSE_RUN:
        runner.isPaused = true;
        return { paused: true };
      case MESSAGE_TYPES.RESUME_RUN:
        runner.isPaused = false;
        if (!runner.isRunning) queueMicrotask(() => startRunner().catch(swallowRunnerError));
        return { resumed: true };
      case MESSAGE_TYPES.STOP_RUN:
        runner.shouldStop = true;
        runner.isPaused = false;
        return { stopped: true };
      case MESSAGE_TYPES.PING:
        return { pong: true };
      case MESSAGE_TYPES.TEST_DETECT:
        return { detection: detectAll() };
      default:
        return {};
    }
  }

  async function startRunner() {
    if (runner.isRunning) return;
    runner.isRunning = true;
    runner.shouldStop = false;
    runner.startedAt = Date.now();

    // Make sure overrides are in memory before we touch the DOM.
    await window.ChatGPTAutomation.loadSelectorOverrides();

    try {
      while (true) {
        const state = await getState();
        const settings = state.settings || {};
        const nextIndex = state.queue.findIndex((item) =>
          item.status === STATUS.PENDING || item.status === STATUS.RUNNING
        );

        if (runner.shouldStop || state.runState.status === RUN_STATUS.STOPPED) {
          await patchContentState({
            runState: { status: RUN_STATUS.STOPPED, lastUpdatedAt: new Date().toISOString() }
          });
          await log("Đã dừng theo yêu cầu của user.", "info");
          break;
        }

        if (runner.isPaused || state.runState.status === RUN_STATUS.PAUSED) {
          await sleep(500);
          continue;
        }

        if (nextIndex === -1) {
          await patchContentState({
            currentIndex: state.queue.length - 1,
            runState: {
              status: RUN_STATUS.COMPLETED,
              lastUpdatedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString()
            }
          });
          await log("Đã xử lý xong toàn bộ queue.", "info");
          break;
        }

        const item = state.queue[nextIndex];
        await processItem(item, nextIndex, settings);

        const delay = computeDelay(settings);
        if (delay > 0) await sleep(delay);
      }
    } finally {
      runner.isRunning = false;
    }
  }

  function computeDelay(settings) {
    const base = Number(settings.delayBetweenJobsMs || 0);
    const jitter = Number(settings.delayJitterMs || 0);
    if (jitter <= 0) return base;
    const offset = Math.floor((Math.random() * 2 - 1) * jitter);
    return Math.max(0, base + offset);
  }

  async function processItem(item, index, settings) {
    // Skip if user enabled "skipExistingOutput" and the file already exists.
    if (settings.skipExistingOutput) {
      try {
        const exists = await sendRuntimeMessage({
          type: MESSAGE_TYPES.CHECK_OUTPUT_EXISTS,
          filename: item.outputFilename
        });
        if (exists?.exists) {
          await updateItem(item.id, {
            status: STATUS.SKIPPED,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            errorMessage: "File output đã tồn tại, đã skip."
          });
          await log(`Skip job #${item.index}: ${item.outputFilename} đã có sẵn.`, "info", { itemId: item.id });
          return;
        }
      } catch (_error) {
        // If the check fails, fall through and try to run; failure path will catch.
      }
    }

    await updateItem(item.id, {
      status: STATUS.RUNNING,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorMessage: "",
      retryCount: (item.retryCount || 0)
    });
    await patchContentState({
      currentIndex: index,
      runState: {
        status: RUN_STATUS.RUNNING,
        lastUpdatedAt: new Date().toISOString(),
        startedAt: runner.startedAt ? new Date(runner.startedAt).toISOString() : new Date().toISOString()
      }
    });
    await log(`Bắt đầu job ${item.index}/${item.total} — model:${item.modelFile?.name} scene:${item.sceneFile?.name} product:${item.productFile?.name}`, "info", { itemId: item.id });

    const maxRetries = Number(settings.maxRetries ?? 2);
    let attempt = item.retryCount || 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      if (runner.shouldStop) throw new Error("Runner stopped.");
      try {
        const imageBuffer = settings.mockMode
          ? await createMockImage(item)
          : await runJob(item, settings);

        const base64 = window.ChatGPTAutomation.arrayBufferToBase64(imageBuffer);

        const saveResult = await sendRuntimeMessage({
          type: MESSAGE_TYPES.SAVE_IMAGE,
          payload: {
            base64,
            filename: item.outputFilename,
            mimeType: "image/png"
          }
        });

        await updateItem(item.id, {
          status: STATUS.DONE,
          finishedAt: new Date().toISOString(),
          outputFilename: saveResult.filename,
          retryCount: attempt,
          errorMessage: ""
        });
        await log(`Job #${item.index} xong: ${saveResult.filename}`, "info", { itemId: item.id });
        return;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt > maxRetries || runner.shouldStop) break;
        await log(`Job #${item.index} lỗi, retry ${attempt}/${maxRetries}: ${error.message}`, "warn", { itemId: item.id });
        await updateItem(item.id, { retryCount: attempt, errorMessage: error.message || "Unknown error" });
        // Cool-off between retries; reuse delay setting.
        await sleep(Math.max(2000, computeDelay(settings)));
      }
    }

    await updateItem(item.id, {
      status: STATUS.FAILED,
      finishedAt: new Date().toISOString(),
      retryCount: attempt,
      errorMessage: lastError?.message || "Lỗi không xác định"
    });
    await log(`Job #${item.index} fail sau ${attempt} lần thử: ${lastError?.message}`, "error", { itemId: item.id });
  }

  // ---------- Core job pipeline ----------

  async function runJob(item, settings) {
    const A = window.ChatGPTAutomation;

    // 1) Fetch the 3 reference images from the offscreen doc.
    const fileBundle = await sendRuntimeMessage({
      type: MESSAGE_TYPES.REQUEST_JOB_FILES,
      jobId: item.id,
      files: [
        { role: "model", relPath: item.modelFile.relPath, name: item.modelFile.name },
        { role: "scene", relPath: item.sceneFile.relPath, name: item.sceneFile.name },
        { role: "product", relPath: item.productFile.relPath, name: item.productFile.name }
      ]
    });

    const files = (fileBundle.files || []).map((f) => {
      const blob = A.base64ToBlob(f.base64, f.mimeType);
      return new File([blob], f.name, { type: f.mimeType });
    });

    if (files.length !== 3) {
      throw new Error(`Đọc thiếu ảnh reference (${files.length}/3).`);
    }

    // 2) Wait for ChatGPT to be idle from any previous turn.
    await A.waitForChatGPTIdle(Number(settings.idleTimeoutMs || 180000));

    const composer = A.findComposer();
    if (!composer) {
      throw new Error("Không tìm thấy ô nhập prompt trên ChatGPT. Hãy mở https://chatgpt.com và chọn ChatGPT Image.");
    }

    // 3) Clear any leftover attachments from a previous job, then upload the
    // new triple. We snapshot the attachment count BEFORE upload so we wait
    // for exactly +3 new attachments rather than ">= 3 total" — that prevents
    // a stale thumbnail from a prior job satisfying the wait too early.
    await A.clearAllAttachments(5000);
    const baseline = A.countUploadAttachments();
    const serverBaseline = A.countServerUploadedAttachments();
    await A.uploadFiles(files);
    await A.waitForUploadComplete(
      3,
      baseline,
      Number(settings.uploadTimeoutMs || 120000),
      Number(settings.uploadStabilityMs || 2000)
    );

    // CRITICAL: wait for the 3 thumbnails to actually finish uploading to
    // ChatGPT's backend. The thumbnail appears immediately as a blob: preview,
    // but ChatGPT silently rejects submit until <img src> resolves to its
    // backend-api URL. This is the gate that fixes "submit doesn't go through".
    await A.waitForServerUpload(3, serverBaseline, Number(settings.uploadTimeoutMs || 120000));

    // 4) Paste the prompt and wait for the composer to register it. Done
    // AFTER uploads finish so the attach reset doesn't wipe our text.
    await A.setComposerValue(composer, item.prompt);
    await A.waitFor(
      () => A.composerContainsText(composer, item.prompt),
      5000,
      150,
      "Composer không nhận được prompt."
    );

    // 5) Final soft gate: log if our count looks off, but don't abort —
    // ChatGPT's attachment markup varies and a missed count shouldn't block
    // submission when the user can clearly see 3 thumbnails on screen.
    const attachedNow = A.countUploadAttachments();
    if (attachedNow < baseline + 3) {
      await log(`Lưu ý: detect được ${attachedNow - baseline}/3 attachment. Vẫn tiếp tục submit.`, "warn", { itemId: item.id });
    }

    // 6) Click submit (or fallback to Enter). Filter out mic/stop variants.
    let submitButton = null;
    try {
      submitButton = await A.waitFor(
        () => A.findSubmitButton(),
        Number(settings.submitTimeoutMs || 20000),
        300,
        "Không tìm thấy nút Submit."
      );
    } catch (_error) {
      submitButton = null;
    }

    // Snapshot existing images RIGHT BEFORE submit, after uploads have
    // landed. Anything that appears after this point is part of the
    // assistant's response. Snapshotting earlier would let upload thumbnails
    // be misclassified as "new" and downloaded as the generated image.
    const beforeImages = A.snapshotImageSources();

    if (submitButton && !A.isVoiceOrMicButton(submitButton) && !A.isStopOrAbortButton(submitButton)) {
      // Use full pointer event chain — ChatGPT may ignore bare .click() with
      // isTrusted=false on the new composer.
      A.robustClick(submitButton);
    } else {
      A.pressEnterOn(composer);
    }

    // 6) Verify a generation actually started.
    await A.waitForSubmissionStart(composer, item.prompt, 20000);

    // 7) Wait for generation to finish.
    await A.waitForGenerationDone(Number(settings.resultTimeoutMs || 240000));

    // 8) Pick up the new image and download it.
    const image = await A.waitForNewImage(beforeImages, {
      resultTimeoutMs: Number(settings.resultTimeoutMs || 240000),
      imageStabilityMs: Number(settings.imageStabilityMs || 2500),
      shouldStop: () => runner.shouldStop
    });
    const imageUrl = image.currentSrc || image.src;
    if (!imageUrl) throw new Error("Không lấy được URL ảnh kết quả.");
    return A.fetchImageBytes(imageUrl);
  }

  // ---------- Mock mode ----------

  async function createMockImage(item) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 42px sans-serif";
    ctx.fillText(`Mock #${item.index}/${item.total}`, 60, 100);
    ctx.font = "24px sans-serif";
    ctx.fillText(`model:  ${item.modelFile?.name || ""}`, 60, 180);
    ctx.fillText(`scene:  ${item.sceneFile?.name || ""}`, 60, 220);
    ctx.fillText(`product: ${item.productFile?.name || ""}`, 60, 260);
    const lines = wrapText(item.prompt || "", 50).slice(0, 16);
    lines.forEach((line, i) => ctx.fillText(line, 60, 320 + i * 32));
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return blob.arrayBuffer();
  }

  function wrapText(text, maxChars) {
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // ---------- Test Detect (called from Options page) ----------

  function detectAll() {
    const A = window.ChatGPTAutomation;
    const composer = A.findComposer();
    const fileInput = A.findFileInput();
    const submit = A.findSubmitButton();
    const stop = A.findStopButton();
    return {
      composer: !!composer,
      composerDescription: describeNode(composer),
      fileInput: !!fileInput,
      fileInputDescription: describeNode(fileInput),
      submit: !!submit,
      submitDescription: describeNode(submit),
      stopVisible: !!stop,
      thumbCount: A.countUploadThumbnails()
    };
  }

  function describeNode(node) {
    if (!node) return null;
    const tag = node.tagName?.toLowerCase() || "?";
    const id = node.id ? `#${node.id}` : "";
    const aria = node.getAttribute?.("aria-label") || "";
    const testid = node.getAttribute?.("data-testid") || "";
    return `${tag}${id}${aria ? `[aria="${aria}"]` : ""}${testid ? `[testid="${testid}"]` : ""}`;
  }

  // ---------- IPC helpers ----------

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function swallowRunnerError(error) {
    log(`Runner exited: ${error?.message || error}`, "warn").catch(() => null);
  }

  async function getState() {
    const response = await sendRuntimeMessage({ type: MESSAGE_TYPES.GET_STATE });
    return response.state;
  }

  async function updateItem(itemId, patch) {
    return sendRuntimeMessage({ type: MESSAGE_TYPES.UPDATE_QUEUE_ITEM, itemId, patch });
  }

  async function patchContentState(patch) {
    return sendRuntimeMessage({ type: MESSAGE_TYPES.CONTENT_STATUS, patch });
  }

  async function log(message, level = "info", extra = {}) {
    return sendRuntimeMessage({ type: MESSAGE_TYPES.APPEND_LOG, message, level, extra });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Extension message failed."));
          return;
        }
        resolve(response);
      });
    });
  }
})();
