// Default DOM selectors for ChatGPT Image. Loaded as a content script so the
// rest of the automation code can read window.ChatGPTImageSelectors. Users may
// override every list from the Options page; merging happens in
// chatgptAutomation.js when it reads chrome.storage.

(function attachSelectors() {
  if (window.ChatGPTImageSelectors) {
    return;
  }

  window.ChatGPTImageSelectors = {
    // Editable target where we paste the prompt text.
    composerTargets: [
      "div#prompt-textarea[contenteditable='true']",
      "div.ProseMirror#prompt-textarea",
      "div.ProseMirror[contenteditable='true']",
      "[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'][data-lexical-editor='true']",
      "form [contenteditable='true']",
      "[data-testid='prompt-textarea']",
      "[placeholder*='Describe or edit an image']",
      "[placeholder*='Message ChatGPT']",
      "[placeholder*='What']",
      "[aria-label*='message']",
      "[aria-label*='image']",
      "form textarea",
      "textarea"
    ],
    // Hidden file input(s) used for attaching images. We pick the first usable.
    fileInputTargets: [
      "input[type='file'][accept*='image']",
      "input[type='file'][multiple]",
      "input[type='file']"
    ],
    // Drop zone used as fallback when the file input is not reachable.
    uploadAreaTargets: [
      "form[data-type='unified-composer']",
      "form",
      "[data-testid='conversation-turn-textbox']",
      "main"
    ],
    // The send / submit button.
    submitTargets: [
      "button[data-testid='send-button']",
      "button[data-testid='fruitjuice-send-button']",
      "button[data-testid*='send']",
      "#composer-submit-button",
      "button#composer-submit-button",
      "button[aria-label*='Send prompt' i]",
      "button[aria-label*='Send message' i]",
      "button[aria-label*='Send' i]",
      "button[aria-label*='Create' i]",
      "button[aria-label*='Generate' i]",
      "form button[type='submit']",
      "form [data-testid='composer-speech-button'] ~ button",
      "form button:last-of-type"
    ],
    // Where final images render in the assistant message. Kept tight on
    // purpose — `main img` / `article img` would also match the user-message
    // upload thumbnails and we'd download those instead of the generated one.
    resultImageTargets: [
      "img[alt^='Generated image' i]",
      "img[alt*='Generated image' i]",
      "[data-message-author-role='assistant'] img[src*='backend-api/estuary']",
      "[data-message-author-role='assistant'] img[src*='oaiusercontent']",
      "[data-message-author-role='assistant'] img[src^='https://files.oaiusercontent.com/']",
      "[data-message-author-role='assistant'] img"
    ],
    // Thumbnails ChatGPT shows after a successful upload (one per attached image).
    uploadThumbTargets: [
      "[data-testid*='attachment'] img",
      "[data-testid*='file-attachment'] img",
      "[data-testid='composer-attachments'] img",
      "form [class*='attachment'] img",
      "form img[alt*='attachment' i]",
      "form img[alt*='Uploaded' i]",
      "form img[src^='blob:']",
      "form img[src^='data:image']"
    ],
    // Containers wrapping each attachment tile. Used as the most reliable
    // count: 1 tile = 1 bound upload. The `Open image in full view` button is
    // the live ChatGPT marker — every confirmed thumbnail wraps inside one.
    uploadTileTargets: [
      "button[aria-label='Open image in full view']",
      "button[aria-label*='Open image' i]",
      "[data-testid='composer-attachments'] > *",
      "[data-testid*='attachment-tile']",
      "[data-testid*='file-attachment']",
      "form [class*='AttachmentTile']",
      "form [class*='attachment-tile']"
    ],
    // URL prefixes that indicate the file finished uploading to ChatGPT's
    // backend (not just a local blob preview). Submit BEFORE these appear is
    // silently dropped by ChatGPT.
    uploadedImageUrlPrefixes: [
      "https://chatgpt.com/backend-api/",
      "https://chat.openai.com/backend-api/",
      "https://files.oaiusercontent.com/"
    ],
    // Per-attachment "remove" / X buttons. Used to clear stale attachments
    // before a new job and as a secondary count signal.
    uploadRemoveButtonTargets: [
      "[data-testid*='attachment'] button",
      "[data-testid='composer-attachments'] button",
      "button[aria-label*='Remove' i]",
      "button[aria-label*='Delete' i]",
      "button[aria-label*='Xóa' i]",
      "button[aria-label*='Bỏ' i]",
      "form button[aria-label*='close' i]"
    ],
    // Progress / generating indicators (Stop button or loading spinner).
    generatingTargets: [
      "button[aria-label*='Stop' i]",
      "button[data-testid*='stop']",
      "[aria-label='Generating']",
      "[role='status']"
    ],
    // Hint phrases used to confirm we picked the real composer (vs. a hidden one).
    textHints: [
      "send a message",
      "message chatgpt",
      "describe",
      "create",
      "image",
      "prompt",
      "what's on your mind"
    ],
    buttonHints: ["send", "generate", "create", "submit"]
  };
})();
