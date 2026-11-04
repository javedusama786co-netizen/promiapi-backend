// =========================================================================
// ☁️ Cloudflare R2 storage (S3-compatible) - ONE shared module
//
// Why: Render's disk is wiped on every restart/deploy, so files saved in ./uploads disappear.
// Files now live in the R2 bucket. Every file keeps the SAME path style as before
// ("/uploads/<something>"), so URLs already stored in MongoDB, the flow builder and the
// frontend keep working. The server serves "/uploads/*" from R2 (see serveFromR2).
//
// Needed env vars (Render):
//   R2_ENDPOINT            https://<ACCOUNT_ID>.r2.cloudflarestorage.com   (WITHOUT the bucket name)
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET_NAME
// Optional:
//   R2_PUBLIC_URL          custom domain of the bucket (e.g. https://cdn.yourdomain.com). When set,
//                          "/uploads/*" simply redirects there. When empty, the server streams the
//                          file from the (private) bucket itself.
//   PUBLIC_BASE_URL        https://api.promiapi.com
//
// Without the 4 R2 variables everything falls back to the local ./uploads folder (local development).
// =========================================================================
const path = require("path");
const fs = require("fs");
const multer = require("multer");
require("dotenv").config();

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const BUCKET = process.env.R2_BUCKET_NAME;
const R2_ENABLED = Boolean(
  process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && BUCKET
);

// The endpoint must NOT contain the bucket name - fix it if someone pasted it that way.
let endpoint = String(process.env.R2_ENDPOINT || "").trim().replace(/\/+$/, "");
if (BUCKET && endpoint.endsWith("/" + BUCKET)) {
  endpoint = endpoint.slice(0, -(BUCKET.length + 1));
  console.warn("⚠️ [R2] R2_ENDPOINT contained the bucket name - removed it. Please fix the env var.");
}

const s3Client = R2_ENABLED
  ? new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      // Newer AWS SDK versions add checksum headers by default; only send them when required (R2 friendly).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  : null;

const multerS3 = R2_ENABLED ? require("multer-s3") : null;

console.log(
  R2_ENABLED
    ? `☁️ [R2] storage ENABLED (bucket "${BUCKET}", ${process.env.R2_PUBLIC_URL ? "redirect to R2_PUBLIC_URL" : "served through this server"})`
    : "💾 [R2] env vars missing - using the LOCAL ./uploads folder (files are lost on Render restarts!)"
);

const UPLOADS_ROOT = path.join(__dirname, "../uploads");
const MB = 1024 * 1024;

// ---------- helpers ----------
const getBaseUrl = (req) =>
  (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

const userSegment = (req) =>
  String(req.user?.adminId || req.user?.id || req.user?._id || "user_101").replace(/[^A-Za-z0-9_-]/g, "");

// safe extension: lower case, letters/digits only, .jfif & co are plain JPEGs
const safeExt = (originalname) => {
  let ext = path.extname(String(originalname || "")).toLowerCase();
  if ([".jfif", ".jpe", ".pjpeg", ".pjp"].includes(ext)) ext = ".jpg";
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
};

const makeName = (prefix, file) =>
  `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt(file.originalname)}`;

/** "/uploads/a/b.jpg" (or a full URL to it) -> "uploads/a/b.jpg", or "" when it is not one of ours */
const keyFromUrl = (value) => {
  if (!value) return "";
  let pathname = String(value).trim().split("?")[0];
  try { pathname = new URL(value).pathname; } catch (e) {}
  try { pathname = decodeURIComponent(pathname); } catch (e) {}
  if (!pathname.startsWith("/uploads/") || pathname.includes("..")) return "";
  return pathname.slice(1);
};

/** URL path ("/uploads/...") of a file that multer just stored (R2 or local disk) */
const urlPathOf = (file) => {
  if (!file) return "";
  if (file.key) return "/" + file.key;
  if (file.path) return "/uploads/" + path.relative(UPLOADS_ROOT, file.path).split(path.sep).join("/");
  return "";
};

// ---------- upload factory ----------
/**
 * createUploader({ folder, perUser, prefix, maxSize, fileFilter })
 *   folder  : sub folder under uploads/            e.g. "bot-replies"
 *   perUser : add the user id as one more folder   uploads/<folder>/<userId>/
 *   prefix  : start of the generated file name     e.g. "mediaFile"
 */
function createUploader({ folder = "", perUser = false, prefix = "file", maxSize = 100 * MB, fileFilter } = {}) {
  const dirFor = (req) => ["uploads", folder, perUser ? userSegment(req) : ""].filter(Boolean).join("/");

  const storage = R2_ENABLED
    ? multerS3({
        s3: s3Client,
        bucket: BUCKET,
        contentType: (req, file, cb) => cb(null, file.mimetype || "application/octet-stream"),
        cacheControl: "public, max-age=31536000, immutable", // names are unique, so caching is safe
        key: (req, file, cb) => cb(null, `${dirFor(req)}/${makeName(prefix, file)}`),
      })
    : multer.diskStorage({
        destination: (req, file, cb) => {
          const dir = path.join(__dirname, "..", dirFor(req));
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, makeName(prefix, file)),
      });

  return multer({ storage, limits: { fileSize: maxSize }, fileFilter });
}

// ---------- object helpers ----------
/** delete a file that multer stored but we do not want to keep (best effort) */
async function deleteFile(file) {
  try {
    if (!file) return;
    if (R2_ENABLED && file.key) await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.key }));
    else if (file.path) fs.unlink(file.path, () => {});
  } catch (e) {
    console.error("⚠️ [R2] deleteFile failed:", e.message);
  }
}

/** delete by stored URL / path (best effort) */
async function deleteByUrl(value) {
  const key = keyFromUrl(value);
  if (!key) return false;
  try {
    if (R2_ENABLED) await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    const local = path.join(UPLOADS_ROOT, key.replace(/^uploads\//, ""));
    if (local.startsWith(UPLOADS_ROOT)) fs.unlink(local, () => {});
    return true;
  } catch (e) {
    console.error("⚠️ [R2] deleteByUrl failed:", e.message);
    return false;
  }
}

/** copy a local file into the bucket (used where a route still needs the file on disk first) */
async function putLocalFile(localPath, key, contentType) {
  if (!R2_ENABLED) return false;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.readFileSync(localPath),
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return true;
}

/** read a whole object into a Buffer (used by the WhatsApp sender) */
async function getObjectBuffer(key) {
  if (!R2_ENABLED) throw new Error("R2 is not configured");
  const obj = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await obj.Body.transformToByteArray());
}

/** list objects under a prefix, newest first */
async function listKeys(prefix) {
  if (!R2_ENABLED) return [];
  const out = [];
  let token;
  do {
    const r = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    (r.Contents || []).forEach((o) => { if (!o.Key.endsWith("/")) out.push({ key: o.Key, lastModified: o.LastModified }); });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
}

// ---------- express middleware: serve "/uploads/*" from R2 ----------
// Mount it AFTER express.static: files still on the local disk are served by static, everything else comes from R2.
async function serveFromR2(req, res, next) {
  if (!R2_ENABLED || (req.method !== "GET" && req.method !== "HEAD")) return next();

  let rel;
  try { rel = decodeURIComponent(req.path); } catch (e) { return next(); }
  if (!rel || rel === "/" || rel.includes("..")) return next();
  const key = "uploads" + rel;

  if (process.env.R2_PUBLIC_URL) {
    const base = process.env.R2_PUBLIC_URL.replace(/\/+$/, "");
    return res.redirect(302, `${base}/${key.split("/").map(encodeURIComponent).join("/")}`);
  }

  try {
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: req.headers.range }));
    res.status(obj.ContentRange ? 206 : 200);
    res.setHeader("Content-Type", obj.ContentType || "application/octet-stream");
    if (obj.ContentLength != null) res.setHeader("Content-Length", obj.ContentLength);
    if (obj.ContentRange) res.setHeader("Content-Range", obj.ContentRange);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", obj.CacheControl || "public, max-age=31536000, immutable");
    if (obj.ETag) res.setHeader("ETag", obj.ETag);
    if (req.method === "HEAD") return res.end();
    obj.Body.on("error", () => res.destroy());
    obj.Body.pipe(res);
  } catch (e) {
    const status = e.$metadata?.httpStatusCode;
    if (e.name === "NoSuchKey" || status === 404) return res.status(404).send("File not found");
    if (status === 416) return res.status(416).end();
    console.error(`❌ [R2] serve failed for ${key}:`, e.name || "", e.message);
    return res.status(502).send("Storage error");
  }
}

// ---------- default export: a ready-made uploader (same usage as before: upload.single("file")) ----------
const defaultUpload = createUploader({ folder: "files", prefix: "file", maxSize: 10 * MB });

module.exports = defaultUpload;
module.exports.createUploader = createUploader;
module.exports.R2_ENABLED = R2_ENABLED;
module.exports.getBaseUrl = getBaseUrl;
module.exports.userSegment = userSegment;
module.exports.keyFromUrl = keyFromUrl;
module.exports.urlPathOf = urlPathOf;
module.exports.deleteFile = deleteFile;
module.exports.deleteByUrl = deleteByUrl;
module.exports.putLocalFile = putLocalFile;
module.exports.getObjectBuffer = getObjectBuffer;
module.exports.listKeys = listKeys;
module.exports.serveFromR2 = serveFromR2;