const crypto = require("node:crypto");
const path = require("node:path");

// Bounded extraction is intentional. Every limit is represented in the result.
const MAX_ROWS = 500;
const MAX_COLUMNS = 64;
const MAX_CHARS = 30000;

async function parseDocument(fileName, mime, buffer) {
  const source = { file_name: fileName, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), size_bytes: buffer.length };
  try {
    const extension = path.extname(fileName).toLowerCase();
    if ([".xlsx", ".xls", ".csv"].includes(extension)) {
      const XLSX = require("xlsx");
      const workbook = XLSX.read(extension === ".csv" ? buffer.toString("utf8") : buffer, {
        type: extension === ".csv" ? "string" : "buffer", raw: true, sheetRows: MAX_ROWS + 1,
      });
      let remainingRows = MAX_ROWS, remainingChars = MAX_CHARS, partial = false, totalRows = 0;
      const sheets = [];
      for (const name of workbook.SheetNames) {
        const sheet = workbook.Sheets[name];
        const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"] || "A1:A1");
        const sourceRows = sheet["!ref"] ? range.e.r - range.s.r + 1 : 0;
        totalRows += sourceRows;
        const readRange = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
        readRange.e.c = Math.min(readRange.e.c, readRange.s.c + MAX_COLUMNS - 1);
        readRange.e.r = Math.min(readRange.e.r, readRange.s.r + MAX_ROWS);
        const values = sheet["!ref"] ? XLSX.utils.sheet_to_json(sheet, { range: readRange, header: 1, blankrows: true, defval: null }) : [];
        const retained = [];
        for (const row of values) {
          const clipped = row.slice(0, MAX_COLUMNS);
          const cost = JSON.stringify(clipped).length;
          if (remainingRows <= 0 || cost > remainingChars) { partial = true; break; }
          if (row.length > MAX_COLUMNS) partial = true;
          retained.push(clipped);
          remainingRows -= 1;
          remainingChars -= cost;
        }
        if (retained.length < sourceRows || range.e.c - range.s.c + 1 > MAX_COLUMNS) partial = true;
        sheets.push({ name, source_range: sheet["!fullref"] || sheet["!ref"] || null, first_row: range.s.r + 1, first_column: range.s.c + 1, source_rows: sourceRows, extracted_rows: retained.length, rows: retained });
      }
      const first = sheets[0]?.rows || [];
      return { status: partial ? "partial" : "parsed", rows: totalRows, summary: {
        source, extraction_complete: !partial, sheets: workbook.SheetNames,
        headers: first[0] || [], sample: first.slice(1), sheet_data: sheets,
        limitations: ["Cell values only; formatting, charts, embedded objects and formula recalculation are not supported.", ...(partial ? ["Extraction limits reached; omitted content has not been read."] : [])],
      } };
    }
    let text, warnings = [];
    if (extension === ".docx") {
      const result = await require("mammoth").extractRawText({ buffer });
      text = (result.value || "").trim();
      warnings = (result.messages || []).map((message) => String(message.message).slice(0, 300));
    } else if (extension === ".txt") {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } else {
      return { status: "unsupported", rows: null, summary: { source, extraction_complete: false, note: "Original stored. This version extracts text from XLSX, XLS, CSV, DOCX and UTF-8 TXT only." } };
    }
    const partial = text.length > MAX_CHARS || warnings.length > 0;
    return { status: partial ? "partial" : "parsed", rows: null, summary: {
      source, extraction_complete: !partial, text: text.slice(0, MAX_CHARS), chars: text.length,
      extracted_chars: Math.min(text.length, MAX_CHARS), warnings,
      limitations: extension === ".docx" ? ["Text extraction only; image content, layout and embedded objects are not read."] : [],
    } };
  } catch {
    return { status: "failed", rows: null, summary: { source, extraction_complete: false, error: "Could not extract this file. The original remains stored for review." } };
  }
}

module.exports = { parseDocument };
