/**
 * Backblaze B2 Storage Service
 * Replaces Bunny.net from the original spec.
 *
 * B2 API flow:
 *   1. b2_authorize_account  → authorizationToken + apiUrl
 *   2. b2_get_upload_url     → uploadUrl + uploadAuthorizationToken
 *   3. b2_upload_file        → fileId + fileName → build friendly URL
 *
 * We cache the upload URL per session (valid for one hour or ~1000 uploads).
 */

import axios from "axios";
import crypto from "crypto";

const B2_API = "https://api.backblazeb2.com/b2api/v3";

// In-memory cache for B2 credentials (re-authorize every 23 h to be safe)
let _auth = null;
let _authExpiry = 0;
let _uploadUrlCache = null;

async function authorizeAccount() {
  if (_auth && Date.now() < _authExpiry) return _auth;

  const credentials = Buffer.from(
    `${process.env.B2_APPLICATION_KEY_ID}:${process.env.B2_APPLICATION_KEY}`
  ).toString("base64");

  const { data } = await axios.get(`${B2_API}/b2_authorize_account`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  _auth = {
    authToken: data.authorizationToken,
    apiUrl: data.apiInfo.storageApi.apiUrl,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
  };
  _authExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
  _uploadUrlCache = null; // invalidate upload URL cache on re-auth
  return _auth;
}

async function getUploadUrl() {
  if (_uploadUrlCache) return _uploadUrlCache;

  const auth = await authorizeAccount();
  const { data } = await axios.post(
    `${auth.apiUrl}/b2api/v3/b2_get_upload_url`,
    { bucketId: process.env.B2_BUCKET_ID },
    { headers: { Authorization: auth.authToken } }
  );

  _uploadUrlCache = {
    uploadUrl: data.uploadUrl,
    uploadAuthToken: data.authorizationToken,
    downloadUrl: auth.downloadUrl,
  };
  return _uploadUrlCache;
}

/**
 * Upload a buffer to Backblaze B2
 * @param {Buffer} fileBuffer  - File content
 * @param {string} fileName    - Path/name inside the bucket (e.g. qrcodes/abc123.png)
 * @param {string} contentType - MIME type
 * @returns {string} Public CDN URL of the uploaded file
 */
async function uploadToB2(fileBuffer, fileName, contentType) {
  // Invalidate cached upload URL on 401/503 (handled in catch below)
  let attempt = 0;

  while (attempt < 2) {
    try {
      const { uploadUrl, uploadAuthToken, downloadUrl } = await getUploadUrl();

      const sha1 = crypto.createHash("sha1").update(fileBuffer).digest("hex");

      await axios.post(uploadUrl, fileBuffer, {
        headers: {
          Authorization: uploadAuthToken,
          "X-Bz-File-Name": encodeURIComponent(fileName),
          "Content-Type": contentType,
          "Content-Length": fileBuffer.length,
          "X-Bz-Content-Sha1": sha1,
        },
        maxBodyLength: Infinity,
      });

      // Build friendly URL
      // Format: {downloadUrl}/file/{bucketName}/{fileName}
      const publicUrl = `${downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}`;

      // If a CDN (e.g. Cloudflare) is configured in front of B2, swap the domain
      if (process.env.B2_CDN_HOST) {
        return `https://${process.env.B2_CDN_HOST}/${fileName}`;
      }

      return publicUrl;
    } catch (err) {
      // B2 upload URL expired or bucket capacity issue → get fresh URL and retry
      _uploadUrlCache = null;
      if (attempt === 1) {
        throw new Error(`B2 upload failed: ${err.message}`);
      }
      attempt++;
    }
  }
}

/**
 * Delete a file from B2 (pass the file name relative to bucket root)
 * B2 requires fileId for deletion — we do a list + delete pattern.
 */
async function deleteFromB2(fileName) {
  try {
    const auth = await authorizeAccount();

    // Find the file to get its fileId
    const { data: listData } = await axios.post(
      `${auth.apiUrl}/b2api/v3/b2_list_file_names`,
      {
        bucketId: process.env.B2_BUCKET_ID,
        prefix: fileName,
        maxFileCount: 1,
      },
      { headers: { Authorization: auth.authToken } }
    );

    const file = listData.files?.[0];
    if (!file) return; // already deleted / not found

    await axios.post(
      `${auth.apiUrl}/b2api/v3/b2_delete_file_version`,
      { fileId: file.fileId, fileName: file.fileName },
      { headers: { Authorization: auth.authToken } }
    );
  } catch (err) {
    console.error("B2 delete error:", err.message);
    // Non-fatal — log and continue
  }
}

export { uploadToB2, deleteFromB2 };
