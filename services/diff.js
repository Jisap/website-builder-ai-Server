import crypto from "crypto";

export function hashContent(content) {
  return crypto.createHash("md5").update(content).digest("hex").slice(0, 12);
}

// Apply AI file operations (create, update, delete) to project files
export function applyOperations(currentFiles, operations) {
  const files = { ...currentFiles };
  const applied = [];
  const errors = [];

  for (const op of operations) {
    try {
      switch (op.op) {
        case "create": {
          if (!op.content) {
            errors.push(`create ${op.path}: missing content`);
            break;
          }
          files[op.path] = {
            content: op.content,
            hash: hashContent(op.content),
          };
          applied.push(`created ${op.path}`);
          break;
        }

        case "update": {
          const existing = files[op.path];
          if (!existing) {
            // If update file doesn't exist yet, auto-convert to create if content or replace is provided
            const newCode = op.content || op.replace;
            if (newCode) {
              files[op.path] = {
                content: newCode,
                hash: hashContent(newCode),
              };
              applied.push(`created (fallback) ${op.path}`);
              break;
            }
            errors.push(`update ${op.path}: file not found`);
            break;
          }

          // Fallback 1: If full content is provided for update, use it directly
          if (op.content && op.content.trim().length > 0) {
            files[op.path] = {
              content: op.content,
              hash: hashContent(op.content),
            };
            applied.push(`updated (full rewrite) ${op.path}`);
            break;
          }

          if (!op.search || op.replace == null) {
            errors.push(`update ${op.path}: missing search/replace`);
            break;
          }

          const newContent = searchReplace(existing.content, op.search, op.replace);

          if (newContent === null) {
            errors.push(`update ${op.path}: search string not found in file content`);
            break;
          }

          files[op.path] = {
            content: newContent,
            hash: hashContent(newContent),
          };
          applied.push(`updated ${op.path}`);
          break;
        }

        case "delete": {
          if (files[op.path]) {
            delete files[op.path];
            applied.push(`deleted ${op.path}`);
          } else {
            errors.push(`delete ${op.path}: file not found`);
          }
          break;
        }

        default:
          errors.push(`unknown op: ${op.op}`);
      }
    } catch (err) {
      errors.push(`${op.op} ${op.path}: ${err.message}`);
    }
  }

  return { files, applied, errors };
}

// Search and replace code with fallback whitespace and fuzzy-matching
function searchReplace(content, search, replace) {
  if (!search || !content) return null;

  // 1. Exact match
  if (content.includes(search)) {
    return content.replace(search, () => replace);
  }

  // 2. Trimmed exact match
  const searchTrimmed = search.trim();
  if (searchTrimmed && content.includes(searchTrimmed)) {
    return content.replace(searchTrimmed, () => replace);
  }

  // 3. Normalize whitespace (collapse spaces/tabs, ignore empty lines)
  const normalizeWs = (s) =>
    s
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");

  const normalizedContent = normalizeWs(content);
  const normalizedSearch = normalizeWs(search);

  if (normalizedSearch && normalizedContent.includes(normalizedSearch)) {
    const searchLines = search.split("\n").map((l) => l.trim()).filter(Boolean);
    const contentLines = content.split("\n");

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const before = contentLines.slice(0, i);
        const after = contentLines.slice(i + searchLines.length);
        return [...before, replace, ...after].join("\n");
      }
    }
  }

  // 4. Single-line fuzzy match
  if (!search.includes("\n")) {
    const searchClean = search.replace(/\s+/g, "").toLowerCase();
    const contentLines = content.split("\n");
    const matchIndex = contentLines.findIndex((line) => line.replace(/\s+/g, "").toLowerCase().includes(searchClean));
    if (matchIndex !== -1) {
      contentLines[matchIndex] = replace;
      return contentLines.join("\n");
    }
  }

  return null;
}
