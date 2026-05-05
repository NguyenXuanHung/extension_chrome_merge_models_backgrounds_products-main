// Splits a multi-prompt template file into individual prompt blocks. The
// delimiter line (default "===") must be on its own line. Empty blocks are
// skipped so trailing newlines don't create phantom prompts.

export function splitPrompts(content, delimiter = "===") {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const escaped = String(delimiter || "===").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*$`, "m");

  const lines = normalized.split("\n");
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (pattern.test(line)) {
      blocks.push(current.join("\n").trim());
      current = [];
      continue;
    }
    current.push(line);
  }
  blocks.push(current.join("\n").trim());

  return blocks.filter((block) => block.length > 0);
}
