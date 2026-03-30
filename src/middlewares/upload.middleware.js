// middleware/upload.middleware.js
import multer from "multer";

const storage = multer.memoryStorage();

// ─── Allowed MIME types ───────────────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_PDF_TYPES = ["application/pdf"];
const ALLOWED_ALL_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_PDF_TYPES];

// ─── File filters ─────────────────────────────────────────────────────────────
const imageFilter = (_req, file, cb) => {
    ALLOWED_IMAGE_TYPES.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error("Only JPEG, PNG, WEBP and GIF images are allowed."), false);
};

const pdfFilter = (_req, file, cb) => {
    ALLOWED_PDF_TYPES.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error("Only PDF files are allowed."), false);
};

const anyFilter = (_req, file, cb) => {
    ALLOWED_ALL_TYPES.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error("Only images (JPEG, PNG, WEBP, GIF) and PDF files are allowed."), false);
};

// ─── Multer instances ─────────────────────────────────────────────────────────

/** Single image upload — field name: "picture" */
export const uploadImage = multer({
    storage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single("picture");

/** Single PDF upload — field name: "document" */
export const uploadPdf = multer({
    storage,
    fileFilter: pdfFilter,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
}).single("document");

/** Single file — either image OR pdf — field name: "file" */
export const uploadAny = multer({
    storage,
    fileFilter: anyFilter,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
}).single("file");

/** Multiple files (images + pdfs) — field name: "files", max 10 */
export const uploadMultiple = multer({
    storage,
    fileFilter: anyFilter,
    limits: { fileSize: 20 * 1024 * 1024 },
}).array("files", 10);

// ─── Middleware wrappers — use directly in routes ────────────────────────────
const wrapMulter = (multerFn) => (req, res, next) => {
    multerFn(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ message: err.message });
        }
        if (err) {
            return res.status(400).json({ message: err.message });
        }
        next();
    });
};

export const handleImageUpload = wrapMulter(uploadImage);
export const handlePdfUpload = wrapMulter(uploadPdf);
export const handleAnyUpload = wrapMulter(uploadAny);
export const handleMultipleUpload = wrapMulter(uploadMultiple);