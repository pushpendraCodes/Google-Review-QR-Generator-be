/**
 * QR Code Generation Service
 *
 * Handles:
 *   - PNG generation (with optional custom colour & logo overlay)
 *   - SVG generation
 *   - PDF generation (wraps PNG in a pdfkit document)
 *   - Watermark overlay for free plan
 */

import QRCode from "qrcode";
import sharp from "sharp";
import PDFDocument from "pdfkit";

const WATERMARK_TEXT = "qrreviews.app";

/**
 * Generate QR code as PNG buffer.
 * @param {string} url         - URL to encode
 * @param {string} color       - Hex color for dark modules (e.g. "#1d4ed8")
 * @param {Buffer} [logoBuf]   - Optional logo buffer (paid plan)
 * @param {boolean} watermark  - Whether to overlay watermark text
 * @returns {Promise<Buffer>}
 */
async function generateQRPng(url, color = "#000000", logoBuf = null, watermark = true) {
  const SIZE = 512;
  const QUIET_ZONE = 20;

  // Step 1: Generate base QR as PNG buffer
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    width: SIZE,
    margin: 2,
    color: {
      dark: color,
      light: "#FFFFFF",
    },
    errorCorrectionLevel: logoBuf ? "H" : "M", // High error correction when logo overlaid
  });

  let image = sharp(qrBuffer);

  // Step 2: Overlay logo in centre (paid plan)
  if (logoBuf) {
    const logoSize = Math.floor(SIZE * 0.2); // 20% of QR size
    const resizedLogo = await sharp(logoBuf)
      .resize(logoSize, logoSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .toBuffer();

    const top = Math.floor((SIZE - logoSize) / 2);
    const left = Math.floor((SIZE - logoSize) / 2);

    image = image.composite([{ input: resizedLogo, top, left }]);
  }

  // Step 3: Watermark for free plan
  if (watermark) {
    const svgWatermark = Buffer.from(`
      <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
        <text
          x="${SIZE / 2}"
          y="${SIZE - 10}"
          text-anchor="middle"
          font-family="Arial"
          font-size="14"
          fill="rgba(0,0,0,0.4)"
        >${WATERMARK_TEXT}</text>
      </svg>
    `);
    image = image.composite([{ input: svgWatermark, blend: "over" }]);
  }

  return image.png().toBuffer();
}

/**
 * Generate QR code as SVG string.
 * @param {string} url
 * @param {string} color
 * @returns {Promise<Buffer>} SVG string as Buffer
 */
async function generateQRSvg(url, color = "#000000") {
  const svgString = await QRCode.toString(url, {
    type: "svg",
    color: { dark: color, light: "#FFFFFF" },
    margin: 2,
  });
  return Buffer.from(svgString, "utf-8");
}

/**
 * Generate QR code as PDF.
 * Embeds the PNG QR code in a nicely formatted A4 page.
 * @param {string} url
 * @param {string} businessName
 * @param {Buffer} qrPngBuffer   - Pre-generated PNG
 * @returns {Promise<Buffer>}
 */
async function generateQRPdf(url, businessName, qrPngBuffer) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const doc = new PDFDocument({ size: "A4", margin: 50 });

    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    // Header
    doc
      .fontSize(22)
      .fillColor("#1d4ed8")
      .text("Scan to Leave a Review", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(14)
      .fillColor("#374151")
      .text(businessName, { align: "center" })
      .moveDown(1.5);

    // QR Code centred
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const qrSize = 280;
    const qrX = doc.page.margins.left + (pageWidth - qrSize) / 2;

    doc.image(qrPngBuffer, qrX, doc.y, { width: qrSize, height: qrSize });
    doc.moveDown(14);

    // Footer
    doc
      .fontSize(10)
      .fillColor("#9ca3af")
      .text("Powered by QR Reviews · qrreviews.app", { align: "center" });

    doc.end();
  });
}

export { generateQRPng, generateQRSvg, generateQRPdf };
