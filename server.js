const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DEFAULT_STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, "storage"));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
let STORAGE_DIR = null;
let TRASH_DIR = null;
const CACHE_DIR = path.join(DATA_DIR, "cache");
const DB_FILE = path.join(DATA_DIR, "nas.db");
const DOCUMENTS_PATH = "Documents";
const PAPERS_PATH = `${DOCUMENTS_PATH}/Papers`;
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_SIZE || 10 * 1024 ** 3);
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const loginAttempts = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8", ".rtf": "application/rtf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".odp": "application/vnd.oasis.opendocument.presentation", ".epub": "application/epub+zip",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".aac": "audio/aac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".ogv": "video/ogg", ".mkv": "video/x-matroska", ".zip": "application/zip", ".csv": "text/csv; charset=utf-8",
};
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"]);
const DOCUMENT_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".txt", ".md", ".rtf", ".csv", ".epub"]);
const pendingMetadata = new Set();

for (const dir of [DATA_DIR, CACHE_DIR]) fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, modified_at TEXT NOT NULL, accessed_at TEXT, favorite INTEGER NOT NULL DEFAULT 0,
    trashed_at TEXT, original_path TEXT, width INTEGER, height INTEGER
  );
  CREATE TABLE IF NOT EXISTS papers (
    file_path TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', authors TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL DEFAULT '',
    year INTEGER, doi TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', memo TEXT NOT NULL DEFAULT '', added_date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
  CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at DESC);
  CREATE INDEX IF NOT EXISTS idx_files_favorite ON files(favorite) WHERE favorite = 1;
  CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);
`);

if (!db.prepare("SELECT 1 FROM settings WHERE key='paper_entities_decoded_v1'").get()) {
  const update = db.prepare("UPDATE papers SET title=?,authors=?,venue=?,doi=?,memo=? WHERE file_path=?");
  db.exec("BEGIN");
  try {
    for (const paper of db.prepare("SELECT file_path,title,authors,venue,doi,memo FROM papers").all()) update.run(...[paper.title, paper.authors, paper.venue, paper.doi, paper.memo].map(decodeMetadata), paper.file_path);
    db.prepare("INSERT INTO settings(key,value) VALUES('paper_entities_decoded_v1','1')").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function send(res, status, body = "", headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", ...headers });
  res.end(body);
}
function json(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key]) => key));
}
function cleanRelative(value = "") {
  const normalized = String(value).normalize("NFC").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..") || normalized === ".trash" || normalized.startsWith(".trash/")) return null;
  return normalized;
}
function cleanName(value) {
  const name = String(value || "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]/g, "").trim();
  return !name || name === "." || name === ".." || name === ".trash" ? null : name.slice(0, 255);
}
function preserveExtension(current, requested, isDirectory = false) {
  const extension = isDirectory ? "" : path.extname(current);
  return extension && !requested.toLowerCase().endsWith(extension.toLowerCase()) ? `${requested.slice(0, 255 - extension.length)}${extension}` : requested;
}
function resolveStorage(relative = "", allowTrash = false) {
  if (!STORAGE_DIR) return null;
  const normalized = allowTrash ? String(relative).replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") : cleanRelative(relative);
  if (normalized === null || (!allowTrash && normalized.startsWith(".trash"))) return null;
  const absolute = path.resolve(STORAGE_DIR, normalized);
  if (absolute !== STORAGE_DIR && !absolute.startsWith(`${STORAGE_DIR}${path.sep}`)) return null;
  return absolute;
}
function assertNoSymlink(absolute, allowMissing = false) {
  if (!STORAGE_DIR) return false;
  const relative = path.relative(STORAGE_DIR, absolute);
  let cursor = STORAGE_DIR;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) return allowMissing;
    if (fs.lstatSync(cursor).isSymbolicLink()) return false;
  }
  return true;
}
function kindFor(name, isDirectory = false) {
  if (isDirectory) return "folder";
  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (DOCUMENT_EXT.has(ext)) return "document";
  return "file";
}
function isPaperPath(relative) { return relative.startsWith(`${PAPERS_PATH}/`); }
function mimeFor(name) { return MIME[path.extname(name).toLowerCase()] || "application/octet-stream"; }
function iso(date = new Date()) { return date.toISOString(); }
function decodeMetadata(value) {
  const named = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">" };
  return String(value ?? "").replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|apos|quot|lt|gt));/gi, (entity, decimal, hex, name) => {
    if (name) return named[name.toLowerCase()];
    const codePoint = Number.parseInt(decimal || hex, hex ? 16 : 10);
    return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : entity;
  });
}
function fileRecord(relative, stat, trashedAt = null, originalPath = null) {
  return { path: relative, name: path.posix.basename(relative), kind: kindFor(relative, stat.isDirectory()), mime: stat.isDirectory() ? "inode/directory" : mimeFor(relative), size: stat.isDirectory() ? 0 : stat.size, created_at: iso(stat.birthtime), modified_at: iso(stat.mtime), trashed_at: trashedAt, original_path: originalPath };
}
const upsertFile = db.prepare(`INSERT INTO files(path,name,kind,mime,size,created_at,modified_at,trashed_at,original_path)
  VALUES(@path,@name,@kind,@mime,@size,@created_at,@modified_at,@trashed_at,@original_path)
  ON CONFLICT(path) DO UPDATE SET name=excluded.name,kind=excluded.kind,mime=excluded.mime,size=excluded.size,modified_at=excluded.modified_at,trashed_at=excluded.trashed_at,original_path=excluded.original_path`);
function syncEntry(relative, absolute = resolveStorage(relative)) {
  if (!absolute || !fs.existsSync(absolute) || !assertNoSymlink(absolute)) return null;
  const record = fileRecord(relative, fs.statSync(absolute));
  upsertFile.run(record);
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(relative);
  if (record.kind === "pdf" && isPaperPath(relative) && !db.prepare("SELECT 1 FROM papers WHERE file_path=?").get(relative)) parsePdfMetadata(relative);
  if (record.kind === "image" && !row.width) parseImageMetadata(relative);
  return row;
}
function scanTree(dir = STORAGE_DIR, base = "", limit = { count: 0 }) {
  if (!dir) return;
  // ponytail: synchronous startup scan is intentionally capped; move to a worker when libraries exceed 50k entries.
  if (limit.count >= 50000) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".trash" || entry.isSymbolicLink()) continue;
    const relative = path.posix.join(base, entry.name);
    syncEntry(relative, path.join(dir, entry.name));
    limit.count += 1;
    if (entry.isDirectory()) scanTree(path.join(dir, entry.name), relative, limit);
    if (limit.count >= 50000) break;
  }
}

function scrypt(password, salt) { return crypto.scryptSync(password, salt, 64).toString("hex"); }
function activateStorage(value, mode = "existing", persist = false) {
  const candidate = path.resolve(String(value || ""));
  if (!path.isAbsolute(String(value || "")) || candidate === path.parse(candidate).root) throw new Error("루트가 아닌 절대 경로를 입력하세요.");
  if (mode === "managed") fs.mkdirSync(candidate, { recursive: true });
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory() || fs.lstatSync(candidate).isSymbolicLink()) throw new Error("사용할 수 있는 디렉터리를 찾지 못했습니다.");
  fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
  STORAGE_DIR = candidate; TRASH_DIR = path.join(candidate, ".trash"); fs.mkdirSync(TRASH_DIR, { recursive: true });
  if (persist) {
    db.prepare("INSERT INTO settings(key,value) VALUES('storage_path',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(candidate);
    db.prepare("INSERT INTO settings(key,value) VALUES('storage_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
  }
  return candidate;
}
function initializeConfiguration() {
  const current = db.prepare("SELECT value FROM settings WHERE key='password'").get();
  if (current && process.env.NAS_PASSWORD) {
    const [salt, expected] = current.value.split(":"); const next = scrypt(process.env.NAS_PASSWORD, salt);
    if (next !== expected) { db.prepare("UPDATE settings SET value=? WHERE key='password'").run(`${salt}:${next}`); db.prepare("DELETE FROM sessions").run(); }
  } else if (!current && process.env.NAS_PASSWORD) {
    const salt = crypto.randomBytes(16).toString("hex");
    db.prepare("INSERT INTO settings(key,value) VALUES('password',?)").run(`${salt}:${scrypt(process.env.NAS_PASSWORD, salt)}`);
  }
  const storedPath = db.prepare("SELECT value FROM settings WHERE key='storage_path'").get()?.value;
  const storedMode = db.prepare("SELECT value FROM settings WHERE key='storage_mode'").get()?.value || "existing";
  if (storedPath) activateStorage(storedPath, storedMode);
  else if (process.env.NAS_PASSWORD) activateStorage(DEFAULT_STORAGE_DIR, "managed", true);
}
initializeConfiguration();
function session(req) {
  const token = parseCookies(req).nas_session;
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT csrf,expires_at FROM sessions WHERE token_hash=?").get(tokenHash);
  if (!row || row.expires_at < Date.now()) { if (row) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash); return null; }
  return { tokenHash, csrf: row.csrf };
}
function requireAuth(req, res, write = false) {
  const current = session(req);
  if (!current) { json(res, 401, { error: "로그인이 필요합니다." }); return null; }
  if (write && req.headers["x-csrf-token"] !== current.csrf) { json(res, 403, { error: "요청 검증에 실패했습니다." }); return null; }
  return current;
}
function createSession(res, payload = {}) {
  const token = crypto.randomBytes(32).toString("base64url"); const csrf = crypto.randomBytes(24).toString("base64url"); const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO sessions(token_hash,csrf,expires_at) VALUES(?,?,?)").run(tokenHash, csrf, Date.now() + SESSION_TTL);
  return json(res, 200, { ok: true, csrf, storageConfigured: Boolean(STORAGE_DIR), ...payload }, { "Set-Cookie": `nas_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${process.env.COOKIE_SECURE === "0" ? "" : "; Secure"}` });
}
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on("data", (chunk) => { size += chunk.length; if (size > limit) { reject(new Error("요청이 너무 큽니다.")); req.destroy(); } else chunks.push(chunk); }); req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error("잘못된 JSON입니다.")); } }); req.on("error", reject); });
}
function uniqueDestination(dir, name) {
  const ext = path.extname(name); const stem = path.basename(name, ext); let candidate = name; let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${stem} (${n++})${ext}`;
  return path.join(dir, candidate);
}
function receiveFile(req, destination) {
  return new Promise((resolve, reject) => {
    const temp = `${destination}.upload-${crypto.randomBytes(5).toString("hex")}`;
    const output = fs.createWriteStream(temp, { flags: "wx", mode: 0o640 }); let size = 0; let settled = false;
    const fail = (error) => { if (settled) return; settled = true; output.destroy(); fs.rm(temp, { force: true }, () => reject(error)); };
    req.on("data", (chunk) => { size += chunk.length; if (size > MAX_UPLOAD) { req.unpipe(output); req.resume(); fail(Object.assign(new Error("파일 크기 제한을 초과했습니다."), { status: 413 })); } });
    req.on("aborted", () => fail(new Error("업로드가 중단되었습니다."))); req.on("error", fail); output.on("error", fail);
    output.on("finish", () => { if (settled) return; if (!size) return fail(new Error("빈 파일은 업로드할 수 없습니다.")); settled = true; fs.rename(temp, destination, (error) => error ? reject(error) : resolve(size)); });
    req.pipe(output);
  });
}
function moveMetadata(oldPath, newPath) {
  const rows = db.prepare("SELECT * FROM files WHERE path=? OR path LIKE ? ORDER BY length(path)").all(oldPath, `${oldPath}/%`);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const next = newPath + row.path.slice(oldPath.length);
      const isDirectory = row.kind === "folder";
      db.prepare("UPDATE files SET path=?,name=?,kind=?,mime=?,modified_at=? WHERE path=?").run(next, path.posix.basename(next), kindFor(next, isDirectory), isDirectory ? "inode/directory" : mimeFor(next), iso(), row.path);
      db.prepare("UPDATE papers SET file_path=? WHERE file_path=?").run(next, row.path);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function ensureLibraryLayout() {
  const documents = resolveStorage(DOCUMENTS_PATH), papers = resolveStorage(PAPERS_PATH);
  fs.mkdirSync(papers, { recursive: true }); syncEntry(DOCUMENTS_PATH, documents); syncEntry(PAPERS_PATH, papers);
  if (db.prepare("SELECT 1 FROM settings WHERE key='library_layout_v1'").get()) return;
  for (const row of db.prepare("SELECT p.file_path FROM papers p JOIN files f ON f.path=p.file_path WHERE f.trashed_at IS NULL AND p.file_path NOT LIKE ?").all(`${PAPERS_PATH}/%`)) {
    const source = resolveStorage(row.file_path); if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile() || !assertNoSymlink(source)) continue;
    const target = uniqueDestination(papers, path.basename(row.file_path)); const next = path.posix.join(PAPERS_PATH, path.basename(target));
    fs.renameSync(source, target); try { moveMetadata(row.file_path, next); } catch (error) { fs.renameSync(target, source); throw error; }
  }
  db.prepare("INSERT INTO settings(key,value) VALUES('library_layout_v1','1')").run();
}
function rowsForDirectory(relative, scope, query, sort) {
  if (scope === "favorites") return db.prepare("SELECT * FROM files WHERE favorite=1 AND trashed_at IS NULL ORDER BY modified_at DESC").all();
  if (scope === "recent") return db.prepare("SELECT * FROM files WHERE accessed_at IS NOT NULL AND trashed_at IS NULL ORDER BY accessed_at DESC LIMIT 100").all();
  if (scope === "trash") return db.prepare("SELECT * FROM files WHERE trashed_at IS NOT NULL AND path NOT LIKE '%/%' ORDER BY trashed_at DESC").all();
  if (scope === "documents" && !(relative === DOCUMENTS_PATH || relative.startsWith(`${DOCUMENTS_PATH}/`) && relative !== PAPERS_PATH && !relative.startsWith(`${PAPERS_PATH}/`))) throw Object.assign(new Error("Documents 폴더를 찾을 수 없습니다."), { status: 404 });
  const absolute = resolveStorage(relative);
  if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory() || !assertNoSymlink(absolute)) throw Object.assign(new Error("폴더를 찾을 수 없습니다."), { status: 404 });
  let rows = fs.readdirSync(absolute, { withFileTypes: true }).filter((entry) => entry.name !== ".trash" && !entry.isSymbolicLink()).map((entry) => syncEntry(path.posix.join(relative, entry.name), path.join(absolute, entry.name)));
  if (scope === "documents") rows = rows.filter((row) => row.path !== PAPERS_PATH && ["folder", "pdf", "document"].includes(row.kind));
  if (query) rows = rows.filter((row) => row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const direction = sort.startsWith("-") ? -1 : 1; const key = sort.replace(/^-/, "") || "name";
  rows.sort((a, b) => (a.kind === "folder" ? -1 : 0) - (b.kind === "folder" ? -1 : 0) || direction * (key === "size" ? a.size - b.size : key === "modified" ? a.modified_at.localeCompare(b.modified_at) : a.name.localeCompare(b.name, "ko", { numeric: true })));
  return rows;
}
function expose(row) { return { ...row, favorite: Boolean(row.favorite), paper: row.kind === "pdf" ? db.prepare("SELECT * FROM papers WHERE file_path=?").get(row.path) || null : undefined }; }
function parsePdfMetadata(relative) {
  const absolute = resolveStorage(relative); if (!absolute) return;
  if (pendingMetadata.has(`pdf:${relative}`)) return; pendingMetadata.add(`pdf:${relative}`);
  const child = spawn("pdfinfo", [absolute], { stdio: ["ignore", "pipe", "ignore"] }); let output = "";
  child.stdout.on("data", (chunk) => output += chunk); child.on("error", () => pendingMetadata.delete(`pdf:${relative}`)); child.on("close", (code) => {
    pendingMetadata.delete(`pdf:${relative}`);
    if (code) return; const fields = Object.fromEntries(output.split("\n").map((line) => line.match(/^([^:]+):\s*(.+)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
    const title = decodeMetadata(fields.Title || path.basename(relative, ".pdf")); const authors = decodeMetadata(fields.Author || "");
    db.prepare("INSERT INTO papers(file_path,title,authors,added_date) VALUES(?,?,?,?) ON CONFLICT(file_path) DO NOTHING").run(relative, title, authors, iso());
  });
}
function parseImageMetadata(relative) {
  const absolute = resolveStorage(relative); if (!absolute) return;
  if (pendingMetadata.has(`image:${relative}`)) return; pendingMetadata.add(`image:${relative}`);
  const child = spawn("identify", ["-format", "%w %h", absolute], { stdio: ["ignore", "pipe", "ignore"] }); let output = "";
  child.stdout.on("data", (chunk) => output += chunk); child.on("error", () => pendingMetadata.delete(`image:${relative}`)); child.on("close", (code) => { pendingMetadata.delete(`image:${relative}`); const [width, height] = output.trim().split(/\s+/).map(Number); if (!code && width && height) db.prepare("UPDATE files SET width=?,height=? WHERE path=?").run(width, height, relative); });
}
function thumbnail(relative, variant, res) {
  const source = resolveStorage(relative); if (!source || !fs.existsSync(source) || !assertNoSymlink(source)) return send(res, 404, "Not found");
  const size = variant === "preview" ? "1600x1600>" : "480x480^";
  const hash = crypto.createHash("sha256").update(`${relative}:${fs.statSync(source).mtimeMs}:${variant}`).digest("hex");
  const target = path.join(CACHE_DIR, `${hash}.webp`);
  const serve = (file) => { res.writeHead(200, { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" }); fs.createReadStream(file).pipe(res); };
  if (fs.existsSync(target)) return serve(target);
  const args = variant === "preview" ? [source, "-auto-orient", "-thumbnail", size, "-quality", "82", target] : [source, "-auto-orient", "-thumbnail", size, "-gravity", "center", "-extent", "480x480", "-quality", "76", target];
  const child = spawn("convert", args); child.on("error", () => streamFile({ headers: {} }, res, relative, false)); child.on("close", (code) => code === 0 && fs.existsSync(target) ? serve(target) : streamFile({ headers: {} }, res, relative, false));
}
function streamFile(req, res, relative, download = false) {
  const absolute = resolveStorage(relative); if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || !assertNoSymlink(absolute)) return send(res, 404, "Not found");
  db.prepare("UPDATE files SET accessed_at=? WHERE path=?").run(iso(), relative);
  const stat = fs.statSync(absolute); const range = req.headers.range; const headers = { "Content-Type": mimeFor(relative), "Accept-Ranges": "bytes", "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(relative))}`, "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff" };
  if (!range) { res.writeHead(200, { ...headers, "Content-Length": stat.size }); return fs.createReadStream(absolute).pipe(res); }
  const match = range.match(/bytes=(\d*)-(\d*)/); if (!match) return send(res, 416, "Invalid range");
  const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start > end || end >= stat.size) return send(res, 416, "Range not satisfiable", { "Content-Range": `bytes */${stat.size}` });
  res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` }); fs.createReadStream(absolute, { start, end }).pipe(res);
}

async function api(req, res, url) {
  if (url.pathname === "/api/auth/status" && req.method === "GET") { const current = session(req); const registered = Boolean(db.prepare("SELECT 1 FROM settings WHERE key='password'").get()); return json(res, 200, { registered, authenticated: Boolean(current), csrf: current?.csrf || null, name: current ? db.prepare("SELECT value FROM settings WHERE key='account_name'").get()?.value : undefined, storageConfigured: Boolean(STORAGE_DIR), defaultStoragePath: current ? DEFAULT_STORAGE_DIR : undefined }); }
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    if (db.prepare("SELECT 1 FROM settings WHERE key='password'").get()) return json(res, 409, { error: "이미 등록이 완료되었습니다." });
    const body = await readJson(req); const password = String(body.password || ""); const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return json(res, 400, { error: "사용자 이름을 입력하세요." });
    if (password.length < 10) return json(res, 400, { error: "비밀번호는 10자 이상이어야 합니다." });
    const salt = crypto.randomBytes(16).toString("hex");
    db.exec("BEGIN");
    try { db.prepare("INSERT INTO settings(key,value) VALUES('password',?)").run(`${salt}:${scrypt(password, salt)}`); db.prepare("INSERT INTO settings(key,value) VALUES('account_name',?)").run(name); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    return createSession(res, { name });
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const address = req.socket.remoteAddress || "unknown"; const attempts = loginAttempts.get(address) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 }; if (attempts.resetAt < Date.now()) { attempts.count = 0; attempts.resetAt = Date.now() + 15 * 60 * 1000; }
    if (attempts.count >= 8) return json(res, 429, { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요." }, { "Retry-After": String(Math.ceil((attempts.resetAt - Date.now()) / 1000)) });
    const body = await readJson(req); const stored = db.prepare("SELECT value FROM settings WHERE key='password'").get(); if (!stored) return json(res, 409, { error: "먼저 관리자를 등록하세요." }); const [salt, expected] = stored.value.split(":"); const actual = scrypt(String(body.password || ""), salt);
    if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) { attempts.count += 1; loginAttempts.set(address, attempts); return json(res, 401, { error: "비밀번호가 올바르지 않습니다." }); }
    loginAttempts.delete(address);
    return createSession(res, { name: db.prepare("SELECT value FROM settings WHERE key='account_name'").get()?.value || "My Archive" });
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") { const current = requireAuth(req, res, true); if (!current) return; db.prepare("DELETE FROM sessions WHERE token_hash=?").run(current.tokenHash); return json(res, 200, { ok: true }, { "Set-Cookie": "nas_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" }); }
  const write = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method); if (!requireAuth(req, res, write)) return;

  if (url.pathname === "/api/storage/setup" && req.method === "POST") {
    if (STORAGE_DIR) return json(res, 409, { error: "저장소가 이미 설정되어 있습니다." });
    const body = await readJson(req); const mode = body.mode === "existing" ? "existing" : body.mode === "managed" ? "managed" : null;
    if (!mode) return json(res, 400, { error: "저장소 생성 방식을 선택하세요." });
    const candidate = mode === "managed" ? DEFAULT_STORAGE_DIR : path.resolve(String(body.path || ""));
    if (mode === "existing" && (!path.isAbsolute(String(body.path || "")) || candidate === ROOT || candidate.startsWith(`${ROOT}${path.sep}`) || ROOT.startsWith(`${candidate}${path.sep}`) || candidate === DATA_DIR || candidate.startsWith(`${DATA_DIR}${path.sep}`))) return json(res, 400, { error: "프로젝트 외부의 안전한 절대 경로를 입력하세요." });
    try { activateStorage(candidate, mode, true); ensureLibraryLayout(); scanTree(); }
    catch (error) { return json(res, 400, { error: error.code === "EACCES" ? "해당 경로에 읽기·쓰기 권한이 없습니다." : error.message }); }
    return json(res, 201, { ok: true, path: STORAGE_DIR });
  }
  if (!STORAGE_DIR) {
    if (url.pathname === "/api/files" && req.method === "GET") return json(res, 200, { setupRequired: true, path: "", entries: [], defaultStoragePath: DEFAULT_STORAGE_DIR });
    return json(res, 409, { error: "먼저 Files에서 저장소를 설정하세요." });
  }

  if (url.pathname === "/api/files" && req.method === "GET") {
    const relative = cleanRelative(url.searchParams.get("path") || ""); if (relative === null) return json(res, 400, { error: "잘못된 경로입니다." });
    const scope = url.searchParams.get("scope") || "files"; const kind = url.searchParams.get("kind");
    if (scope === "media") { if (!new Set(["image", "audio", "video"]).has(kind)) return json(res, 400, { error: "잘못된 미디어 유형입니다." }); return json(res, 200, { path: "", entries: db.prepare("SELECT * FROM files WHERE kind=? AND trashed_at IS NULL ORDER BY modified_at DESC").all(kind).map(expose) }); }
    return json(res, 200, { path: relative, entries: rowsForDirectory(relative, scope, url.searchParams.get("q") || "", url.searchParams.get("sort") || "name").map(expose) });
  }
  if (url.pathname === "/api/files/upload" && req.method === "PUT") {
    const folder = cleanRelative(url.searchParams.get("path") || ""); const name = cleanName(url.searchParams.get("name")); const directory = resolveStorage(folder);
    if (folder === null || !name || !directory || !fs.existsSync(directory) || !assertNoSymlink(directory)) return json(res, 400, { error: "잘못된 업로드 경로입니다." });
    const announced = Number(req.headers["content-length"] || 0); if (announced > MAX_UPLOAD) { req.resume(); return json(res, 413, { error: "파일 크기 제한을 초과했습니다." }); }
    const destination = uniqueDestination(directory, name); await receiveFile(req, destination); const relative = path.posix.join(folder, path.basename(destination)); const record = syncEntry(relative, destination); if (record.kind === "pdf" && isPaperPath(relative)) parsePdfMetadata(relative); if (record.kind === "image") parseImageMetadata(relative); return json(res, 201, { entry: expose(record) });
  }
  if (url.pathname === "/api/folders" && req.method === "POST") {
    const body = await readJson(req); const parent = cleanRelative(body.path || ""); const name = cleanName(body.name); const directory = resolveStorage(parent);
    if (parent === null || !name || !directory || !assertNoSymlink(directory)) return json(res, 400, { error: "잘못된 폴더 이름입니다." });
    const target = path.join(directory, name); fs.mkdirSync(target); return json(res, 201, { entry: expose(syncEntry(path.posix.join(parent, name), target)) });
  }
  if (url.pathname === "/api/files/rename" && req.method === "POST") {
    const body = await readJson(req); const sourceRel = cleanRelative(body.path); const requested = cleanName(body.name); const source = resolveStorage(sourceRel);
    if (!sourceRel || !requested || !source || !fs.existsSync(source) || !assertNoSymlink(source)) return json(res, 400, { error: "잘못된 경로입니다." });
    const name = preserveExtension(path.basename(sourceRel), requested, fs.statSync(source).isDirectory());
    const target = path.join(path.dirname(source), name); if (fs.existsSync(target)) return json(res, 409, { error: "같은 이름의 항목이 이미 있습니다." });
    fs.renameSync(source, target); const targetRel = path.posix.join(path.posix.dirname(sourceRel) === "." ? "" : path.posix.dirname(sourceRel), name); try { moveMetadata(sourceRel, targetRel); } catch (error) { fs.renameSync(target, source); throw error; } return json(res, 200, { path: targetRel });
  }
  if (url.pathname === "/api/files/move" && req.method === "POST") {
    const body = await readJson(req); const sourceRel = cleanRelative(body.path); const destinationRel = cleanRelative(body.destination || ""); const source = resolveStorage(sourceRel); const destination = resolveStorage(destinationRel);
    if (!sourceRel || destinationRel === null || !source || !destination || !fs.existsSync(source) || !fs.existsSync(destination) || !assertNoSymlink(source) || !assertNoSymlink(destination)) return json(res, 400, { error: "잘못된 이동 경로입니다." });
    const target = path.join(destination, path.basename(source)); if (target.startsWith(`${source}${path.sep}`) || fs.existsSync(target)) return json(res, 409, { error: "이동할 수 없는 위치이거나 같은 이름이 이미 있습니다." });
    fs.renameSync(source, target); const targetRel = path.posix.join(destinationRel, path.basename(sourceRel)); try { moveMetadata(sourceRel, targetRel); if (kindFor(targetRel) === "pdf" && isPaperPath(targetRel)) parsePdfMetadata(targetRel); } catch (error) { fs.renameSync(target, source); throw error; } return json(res, 200, { path: targetRel });
  }
  if (url.pathname === "/api/files" && req.method === "DELETE") {
    const body = await readJson(req); const relative = cleanRelative(body.path); const source = resolveStorage(relative);
    if (!relative || !source || !fs.existsSync(source) || !assertNoSymlink(source)) return json(res, 404, { error: "파일을 찾을 수 없습니다." });
    const trashName = `${crypto.randomBytes(8).toString("hex")}-${path.basename(relative)}`; const target = path.join(TRASH_DIR, trashName); fs.renameSync(source, target);
    moveMetadata(relative, trashName); const now = iso(); db.prepare("UPDATE files SET trashed_at=?,original_path=? || substr(path,?) WHERE path=? OR path LIKE ?").run(now, relative, trashName.length + 1, trashName, `${trashName}/%`); return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/files/restore" && req.method === "POST") {
    const body = await readJson(req); const trashName = cleanName(body.path); const row = db.prepare("SELECT * FROM files WHERE path=? AND trashed_at IS NOT NULL").get(trashName); if (!row) return json(res, 404, { error: "휴지통 항목을 찾을 수 없습니다." });
    const source = path.join(TRASH_DIR, trashName); let target = resolveStorage(row.original_path); if (!target) return json(res, 400, { error: "복원 경로가 잘못되었습니다." }); fs.mkdirSync(path.dirname(target), { recursive: true }); if (fs.existsSync(target)) target = uniqueDestination(path.dirname(target), path.basename(target)); fs.renameSync(source, target); const next = path.relative(STORAGE_DIR, target).split(path.sep).join("/"); moveMetadata(trashName, next); db.prepare("UPDATE files SET trashed_at=NULL,original_path=NULL,modified_at=? WHERE path=? OR path LIKE ?").run(iso(), next, `${next}/%`); return json(res, 200, { path: next });
  }
  if (url.pathname === "/api/files/permanent" && req.method === "DELETE") {
    const body = await readJson(req); const trashName = cleanName(body.path); const row = db.prepare("SELECT * FROM files WHERE path=? AND trashed_at IS NOT NULL").get(trashName); if (!row) return json(res, 404, { error: "휴지통 항목을 찾을 수 없습니다." }); fs.rmSync(path.join(TRASH_DIR, trashName), { recursive: true, force: true }); db.prepare("DELETE FROM papers WHERE file_path=? OR file_path LIKE ?").run(trashName, `${trashName}/%`); db.prepare("DELETE FROM files WHERE path=? OR path LIKE ?").run(trashName, `${trashName}/%`); return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/files/favorite" && req.method === "POST") { const body = await readJson(req); const relative = cleanRelative(body.path) || cleanName(body.path); if (!relative) return json(res, 400, { error: "잘못된 경로입니다." }); db.prepare("UPDATE files SET favorite=? WHERE path=?").run(body.value ? 1 : 0, relative); return json(res, 200, { ok: true }); }
  if (url.pathname === "/api/content" && req.method === "GET") { const relative = cleanRelative(url.searchParams.get("path")); if (!relative) return send(res, 400, "Bad path"); return streamFile(req, res, relative, url.searchParams.get("download") === "1"); }
  if (url.pathname === "/api/image" && req.method === "GET") { const relative = cleanRelative(url.searchParams.get("path")); if (!relative || !IMAGE_EXT.has(path.extname(relative).toLowerCase())) return send(res, 400, "Bad image"); return thumbnail(relative, url.searchParams.get("variant") === "preview" ? "preview" : "thumbnail", res); }
  if (url.pathname === "/api/papers" && req.method === "GET") {
    const q = `%${url.searchParams.get("q") || ""}%`; const year = Number(url.searchParams.get("year") || 0); const tag = url.searchParams.get("tag") || ""; const venue = url.searchParams.get("venue") || "";
    const rows = db.prepare(`SELECT p.*,f.size,f.modified_at,f.favorite FROM papers p JOIN files f ON f.path=p.file_path WHERE f.trashed_at IS NULL AND p.file_path LIKE ? AND (p.title LIKE ? OR p.authors LIKE ?) AND (?=0 OR p.year=?) AND (?='' OR p.tags LIKE ?) AND (?='' OR p.venue=?) ORDER BY p.added_date DESC`).all(`${PAPERS_PATH}/%`, q, q, year, year, tag, `%${tag}%`, venue, venue); return json(res, 200, { papers: rows.map((row) => ({ ...row, tags: JSON.parse(row.tags || "[]"), favorite: Boolean(row.favorite) })) });
  }
  if (url.pathname === "/api/papers" && req.method === "PUT") {
    const body = await readJson(req); const filePath = cleanRelative(body.file_path); if (!filePath || !isPaperPath(filePath) || !fs.existsSync(resolveStorage(filePath))) return json(res, 404, { error: "Papers 디렉터리에서 PDF를 찾을 수 없습니다." });
    const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 30) : [];
    db.prepare(`INSERT INTO papers(file_path,title,authors,venue,year,doi,tags,memo,added_date) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(file_path) DO UPDATE SET title=excluded.title,authors=excluded.authors,venue=excluded.venue,year=excluded.year,doi=excluded.doi,tags=excluded.tags,memo=excluded.memo`).run(filePath, String(body.title || path.basename(filePath, ".pdf")).trim(), String(body.authors || "").trim(), String(body.venue || "").trim(), Number(body.year) || null, String(body.doi || "").trim(), JSON.stringify(tags), String(body.memo || "").trim(), iso()); return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/search" && req.method === "GET") {
    const term = String(url.searchParams.get("q") || "").trim(); if (!term) return json(res, 200, { groups: {} }); const like = `%${term}%`;
    const rows = db.prepare("SELECT * FROM files WHERE trashed_at IS NULL AND (name LIKE ? OR path LIKE ?) ORDER BY modified_at DESC LIMIT 40").all(like, like); const papers = db.prepare("SELECT p.*,f.favorite FROM papers p JOIN files f ON f.path=p.file_path WHERE f.trashed_at IS NULL AND p.file_path LIKE ? AND (p.title LIKE ? OR p.authors LIKE ? OR p.tags LIKE ?) LIMIT 20").all(`${PAPERS_PATH}/%`, like, like, like);
    return json(res, 200, { groups: { papers, folders: rows.filter((row) => row.kind === "folder"), files: rows.filter((row) => row.kind !== "folder") } });
  }
  if (url.pathname === "/api/dashboard" && req.method === "GET") {
    const recent = db.prepare("SELECT * FROM files WHERE kind!='folder' AND trashed_at IS NULL ORDER BY modified_at DESC LIMIT 8").all(); const favorites = db.prepare("SELECT * FROM files WHERE favorite=1 AND trashed_at IS NULL ORDER BY modified_at DESC LIMIT 6").all(); const papers = db.prepare("SELECT p.*,f.favorite FROM papers p JOIN files f ON f.path=p.file_path WHERE f.trashed_at IS NULL AND p.file_path LIKE ? ORDER BY p.added_date DESC LIMIT 4").all(`${PAPERS_PATH}/%`); const audio = db.prepare("SELECT * FROM files WHERE kind='audio' AND trashed_at IS NULL ORDER BY COALESCE(accessed_at,modified_at) DESC LIMIT 6").all(); return json(res, 200, { recent, favorites, papers, audio });
  }
  if (url.pathname === "/api/storage" && req.method === "GET") { const row = db.prepare("SELECT COALESCE(SUM(size),0) total,COUNT(*) count FROM files WHERE trashed_at IS NULL AND kind!='folder'").get(); const disk = fs.statfsSync(STORAGE_DIR); const capacity = Number(disk.blocks) * Number(disk.bsize); const available = Number(disk.bavail) * Number(disk.bsize); return json(res, 200, { ...row, capacity, available, diskUsed: capacity - available }); }
  return json(res, 404, { error: "찾을 수 없습니다." });
}

function staticFile(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1); const absolute = path.resolve(PUBLIC_DIR, requested);
  if (!absolute.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return send(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": MIME[path.extname(absolute).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'self'; frame-ancestors 'self'" }); fs.createReadStream(absolute).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") return json(res, 200, { status: "ok" });
  if (url.pathname.startsWith("/api/")) return api(req, res, url).catch((error) => { console.error(error); if (!res.headersSent) json(res, error.status || 400, { error: error.message || "요청을 처리하지 못했습니다." }); else res.destroy(); });
  staticFile(res, url.pathname);
});

if (require.main === module) {
  if (STORAGE_DIR) setImmediate(() => { try { ensureLibraryLayout(); scanTree(); } catch (error) { console.error("Initial scan failed", error); } });
  server.listen(PORT, "0.0.0.0", () => console.log(`Archive NAS is running at http://localhost:${PORT}`));
}

module.exports = { server, cleanRelative, cleanName, resolveStorage, kindFor, decodeMetadata, preserveExtension, isPaperPath };
