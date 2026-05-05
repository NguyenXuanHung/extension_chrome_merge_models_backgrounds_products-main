// Renders the user's prompt.txt template by substituting placeholders and
// appending the aspect-ratio directive. Placeholders supported:
//   {{MODEL_NAME}}    — file name of the chosen mẫu
//   {{SCENE_NAME}}    — file name of the chosen cảnh
//   {{PRODUCT_NAME}}  — file name of the chosen sản phẩm
//   {{INDEX}}         — 1-based job index
//   {{TOTAL}}         — total number of jobs
//   {{ASPECT_RATIO}}  — selected aspect ratio (e.g. 9:16)
//
// Aspect ratio is also auto-appended as: "Make the aspect ratio X:Y." unless
// the template already contains the marker {{ASPECT_RATIO}} (then we trust it).

import { basename } from "./sanitize.js";

export function renderPrompt(template, ctx = {}) {
  const safeTemplate = String(template || "").replace(/\r\n/g, "\n");
  const aspectRatio = ctx.aspectRatio || "9:16";

  const tokens = {
    MODEL_NAME: ctx.modelName || "",
    SCENE_NAME: ctx.sceneName || "",
    PRODUCT_NAME: ctx.productName || "",
    MODEL_BASENAME: basename(ctx.modelName || ""),
    SCENE_BASENAME: basename(ctx.sceneName || ""),
    PRODUCT_BASENAME: basename(ctx.productName || ""),
    INDEX: String(ctx.index ?? ""),
    TOTAL: String(ctx.total ?? ""),
    PROMPT_INDEX: String(ctx.promptIndex ?? ""),
    PROMPT_TOTAL: String(ctx.promptTotal ?? ""),
    ASPECT_RATIO: aspectRatio
  };

  let rendered = safeTemplate.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match;
  });

  // Auto-append aspect ratio line if the template did not opt-in via the placeholder.
  const hasAspectMention = /aspect\s*ratio/i.test(rendered);
  if (!hasAspectMention) {
    const trailer = `\n\nMake the aspect ratio ${aspectRatio}.`;
    rendered = rendered.trimEnd() + trailer;
  }

  return rendered.trim();
}
