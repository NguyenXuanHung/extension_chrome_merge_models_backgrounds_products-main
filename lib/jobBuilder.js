// Builds the cross-product of prompt × model × scene × product into a flat
// job array. Each job carries a stable id, the three source filenames, the
// rendered prompt and the output filename. Total = prompts * models * scenes
// * products. With 1 prompt + 2/2/2 = 8; with 2 prompts + 2/2/2 = 16.

import { STATUS } from "./config.js";
import { renderPrompt } from "./promptRenderer.js";
import { basename, clampFilename, sanitizeFilenamePart } from "./sanitize.js";

export function buildJobs({ promptTemplates, modelFiles, sceneFiles, productFiles, settings }) {
  const prompts = Array.isArray(promptTemplates) && promptTemplates.length
    ? promptTemplates
    : [];
  if (!prompts.length || !modelFiles?.length || !sceneFiles?.length || !productFiles?.length) {
    return [];
  }

  const total = prompts.length * modelFiles.length * sceneFiles.length * productFiles.length;
  const jobs = [];
  const indexPad = String(total).length;
  const promptPad = String(prompts.length).length;
  let index = 0;

  prompts.forEach((promptText, promptIdx) => {
    for (const model of modelFiles) {
      for (const scene of sceneFiles) {
        for (const product of productFiles) {
          index += 1;
          const job = {
            id: crypto.randomUUID(),
            index,
            total,
            promptIndex: promptIdx + 1,
            promptTotal: prompts.length,
            modelFile: model,
            sceneFile: scene,
            productFile: product,
            prompt: renderPrompt(promptText, {
              modelName: model.name,
              sceneName: scene.name,
              productName: product.name,
              index,
              total,
              promptIndex: promptIdx + 1,
              promptTotal: prompts.length,
              aspectRatio: settings.aspectRatio
            }),
            outputFilename: composeOutputFilename({
              prefix: settings.prefix,
              index,
              indexPad,
              promptIndex: promptIdx + 1,
              promptPad,
              promptTotal: prompts.length,
              modelName: model.name,
              sceneName: scene.name,
              productName: product.name,
              maxLength: settings.filenameMaxLength
            }),
            status: STATUS.PENDING,
            retryCount: 0,
            startedAt: null,
            finishedAt: null,
            errorMessage: ""
          };
          jobs.push(job);
        }
      }
    }
  });

  return jobs;
}

export function composeOutputFilename({
  prefix, index, indexPad, promptIndex, promptPad, promptTotal,
  modelName, sceneName, productName, maxLength
}) {
  const paddedIndex = String(index).padStart(indexPad || 1, "0");
  const safePrefix = sanitizeFilenamePart(prefix) || "fashion";
  const m = sanitizeFilenamePart(basename(modelName)) || "model";
  const s = sanitizeFilenamePart(basename(sceneName)) || "scene";
  const p = sanitizeFilenamePart(basename(productName)) || "product";
  // Skip the prompt segment when there's only 1 prompt — keeps filenames short.
  const promptPart = promptTotal && promptTotal > 1
    ? `_p${String(promptIndex).padStart(promptPad || 1, "0")}`
    : "";
  const composed = `${safePrefix}_${paddedIndex}${promptPart}_model-${m}_scene-${s}_product-${p}.png`;
  return clampFilename(composed, maxLength || 180);
}

export function resetFailedJobs(queue, settings) {
  const indexPad = String(queue.length).length;
  const promptTotal = Math.max(...queue.map((j) => j.promptTotal || 1), 1);
  const promptPad = String(promptTotal).length;
  return queue.map((item) => {
    if (item.status !== STATUS.FAILED) {
      return item;
    }
    return {
      ...item,
      status: STATUS.PENDING,
      retryCount: 0,
      errorMessage: "",
      startedAt: null,
      finishedAt: null,
      outputFilename: composeOutputFilename({
        prefix: settings.prefix,
        index: item.index,
        indexPad,
        promptIndex: item.promptIndex || 1,
        promptPad,
        promptTotal,
        modelName: item.modelFile?.name || "model",
        sceneName: item.sceneFile?.name || "scene",
        productName: item.productFile?.name || "product",
        maxLength: settings.filenameMaxLength
      })
    };
  });
}
