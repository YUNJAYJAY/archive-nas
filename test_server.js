const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "archive-nas-test-"));
process.env.DATA_DIR = path.join(sandbox, "data");
process.env.STORAGE_DIR = path.join(sandbox, "storage");
process.env.COOKIE_SECURE = "0";
delete process.env.NAS_PASSWORD;

const { server, cleanRelative, cleanName, resolveStorage, kindFor, decodeMetadata, preserveExtension, isPaperPath } = require("./server");

assert.equal(cleanRelative("Research/Papers"), "Research/Papers");
assert.equal(cleanRelative(""), "");
assert.equal(cleanRelative("../secret"), null);
assert.equal(cleanRelative(".trash/file"), null);
assert.equal(cleanName("../../paper.pdf"), "....paper.pdf");
assert.equal(kindFor("paper.pdf"), "pdf");
assert.equal(kindFor("photo.webp"), "image");
assert.equal(kindFor("song.flac"), "audio");
assert.equal(kindFor("clip.mp4"), "video");
assert.equal(kindFor("report.docx"), "document");
assert.equal(isPaperPath("Documents/Papers/paper.pdf"), true);
assert.equal(isPaperPath("Documents/report.pdf"), false);
assert.equal(decodeMetadata("OccAM&#x0027;s &#38; LiDAR"), "OccAM's & LiDAR");
assert.equal(decodeMetadata("Keep &#x110000; invalid"), "Keep &#x110000; invalid");
assert.equal(preserveExtension("paper.pdf", "새 논문"), "새 논문.pdf");
assert.equal(preserveExtension("paper.pdf", "새 논문.pdf"), "새 논문.pdf");

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${origin}/api/auth/status`); let body = await response.json();
    assert.equal(body.registered, false); assert.equal(body.storageConfigured, false);

    response = await fetch(`${origin}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Test Admin", password: "test-password-123" }) }); body = await response.json();
    assert.equal(response.status, 200); assert.ok(body.csrf);
    const cookie = response.headers.get("set-cookie").split(";", 1)[0];

    fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
    response = await fetch(`${origin}/api/storage/setup`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": body.csrf }, body: JSON.stringify({ mode: "existing", path: process.env.STORAGE_DIR }) });
    assert.equal(response.status, 201); assert.ok(resolveStorage("Documents").startsWith(process.env.STORAGE_DIR));

    response = await fetch(`${origin}/api/files?path=&scope=files`, { headers: { Cookie: cookie } }); body = await response.json();
    assert.equal(response.status, 200); assert.ok(body.entries.some((entry) => entry.path === "Documents"));
    console.log("NAS onboarding, path and type checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
