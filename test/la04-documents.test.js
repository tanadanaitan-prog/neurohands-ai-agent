const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const XLSX = require("xlsx");
const parser = require("../src/lib/document-parser");

const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function docx(text) {
  const zip = XLSX.CFB.utils.cfb_new();
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  for (const [name, contents] of Object.entries(files)) XLSX.CFB.utils.cfb_add(zip, name, Buffer.from(contents));
  return XLSX.CFB.write(zip, { type: "buffer", fileType: "zip" });
}

async function readStoredDocument(parsed_status, parsed_summary) {
  // Exercise the actual gateway method without starting a server or performing IO.
  const source = fs.readFileSync(require.resolve("../src/server"), "utf8");
  const method = source.match(/  async read_document\(ctx, args\) \{[\s\S]*?\n  \},/);
  assert.ok(method, "actual read_document gateway method must be inspectable");
  const handlers = vm.runInNewContext(`({${method[0]}})`, {
    db: async () => [{ doc_code: "SYNTHETIC-DOC", file_name: "synthetic.txt", parsed_status, parsed_summary }],
    documentReadResult: parser.documentReadResult,
  });
  return handlers.read_document({ clientAccountId: 1, department: "sales" }, { doc_code: "SYNTHETIC-DOC" });
}

test("LA04 docs: supported UTF-8 text retains source bytes and literal evidence", async () => {
  const buffer = Buffer.from("Fictional Glass company: 2 panels.\nราคา 100 บาท");
  const result = await parser.parseDocument("source.txt", "text/plain", buffer);
  assert.equal(result.status, "parsed");
  assert.equal(result.summary.text, buffer.toString("utf8"));
  assert.equal(result.summary.source.sha256, crypto.createHash("sha256").update(buffer).digest("hex"));
  assert.equal(result.summary.source.size_bytes, buffer.length);
});

test("LA04 docs: whitespace-only text is not successful readable extraction", async () => {
  const result = await parser.parseDocument("empty.txt", "text/plain", Buffer.from(" \n\t "));
  assert.equal(result.status, "failed");
  assert.equal(result.summary.extraction_complete, false);
});

test("LA04 docs: invalid UTF-8 CSV fails instead of manufacturing replacement characters", async () => {
  const result = await parser.parseDocument("invalid.csv", "text/csv", Buffer.from([0xff, 0xfe, 0x61]));
  assert.equal(result.status, "failed");
  assert.equal(result.summary.extraction_complete, false);
});

test("LA04 docs: empty CSV is not a complete document read", async () => {
  const result = await parser.parseDocument("empty.csv", "text/csv", Buffer.alloc(0));
  assert.equal(result.status, "failed");
  assert.equal(result.summary.extraction_complete, false);
});

test("LA04 docs: CSV renamed XLSX fails its format contract", async () => {
  const result = await parser.parseDocument("renamed.xlsx", "application/octet-stream", Buffer.from("item,qty\nGlass,2"));
  assert.equal(result.status, "failed");
});

test("LA04 docs: quoted UTF-8 CSV preserves precision, newline and zero values", async () => {
  const result = await parser.parseDocument("source.csv", "text/csv", Buffer.from('item,note,exact,quantity\n"กระจก, Glass","first\nsecond","9007199254740993",0'));
  assert.equal(result.status, "parsed");
  assert.equal(result.summary.extraction_complete, true);
  assert.deepEqual(result.summary.sample[0], ["กระจก, Glass", "first\nsecond", "9007199254740993", "0"]);
});

test("LA04 docs: actual XLSX and XLS parse values, with global row and column bounds", async () => {
  for (const bookType of ["xlsx", "xls"]) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["zero", "false"], [0, false]]), "Values");
    const result = await parser.parseDocument(`values.${bookType}`, "application/octet-stream", XLSX.write(book, { type: "buffer", bookType }));
    assert.equal(result.status, "parsed");
    assert.deepEqual(result.summary.sample[0], [0, false]);
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Array.from({ length: 510 }, () => Array(70).fill("value"))), "Large");
  const partial = await parser.parseDocument("bounded.xlsx", "application/octet-stream", XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  assert.equal(partial.status, "partial");
  assert.equal(partial.summary.extraction_complete, false);
  assert.ok(partial.summary.sheet_data.reduce((n, sheet) => n + sheet.extracted_rows, 0) <= 500);
  assert.ok(partial.summary.sheet_data.every(sheet => sheet.rows.every(row => row.length <= 64)));
  assert.match(partial.summary.limitations.join(" "), /omitted content has not been read/);
});

test("LA04 docs: genuine DOCX text parses and empty DOCX never becomes readable", async () => {
  const result = await parser.parseDocument("source.docx", MIME_DOCX, docx("Fictional company service: glass cutting"));
  assert.equal(result.status, "parsed");
  assert.match(result.summary.text, /Fictional company service: glass cutting/);
  assert.match(result.summary.limitations.join(" "), /image content.*not read/);
  const empty = await parser.parseDocument("empty.docx", MIME_DOCX, docx(""));
  assert.equal(empty.status, "failed");
  assert.equal(empty.summary.extraction_complete, false);
});

test("LA04 docs: malformed DOCX, invalid UTF-8 TXT and PDF stay explicit failures or unsupported", async () => {
  assert.equal((await parser.parseDocument("broken.docx", MIME_DOCX, Buffer.from("not a docx"))).status, "failed");
  assert.equal((await parser.parseDocument("broken.txt", "text/plain", Buffer.from([0xff]))).status, "failed");
  const pdf = await parser.parseDocument("source.pdf", "application/pdf", Buffer.from("%PDF fictional bytes"));
  assert.equal(pdf.status, "unsupported");
  assert.equal(pdf.summary.extraction_complete, false);
  assert.equal(pdf.summary.text, undefined);
});

test("LA04 docs: actual gateway rejects stored empty, invalid or metadata-only parsed summaries", async () => {
  for (const summary of [null, {}, { text: " \n", extraction_complete: true }, { source: { file_name: "no-content.txt" } },
    { sheet_data: [{ rows: [[null, " "]] }], extraction_complete: true }]) {
    const result = await readStoredDocument("parsed", summary);
    assert.equal(result.found, true);
    assert.equal(result.readable, false);
    assert.equal(result.extraction_complete, false);
  }
});

test("LA04 docs: actual gateway partial evidence cannot claim complete, and legacy extracted values remain readable", async () => {
  const partial = await readStoredDocument("partial", { text: "Page one only", extraction_complete: true });
  assert.equal(partial.readable, true);
  assert.equal(partial.extraction_complete, false);
  assert.equal(partial.content.extraction_complete, false);
  const legacy = await readStoredDocument("parsed", { headers: ["qty"], sample: [[0]], extraction_complete: true });
  assert.equal(legacy.readable, true);
  assert.equal(legacy.extraction_complete, true);
});
