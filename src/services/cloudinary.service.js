
/**
 * Cloudinary Storage Service
 * Similar structure to Backblaze B2 service
 */

import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload buffer to Cloudinary
 * @param {Buffer} fileBuffer
 * @param {string} fileName (e.g. qrcodes/abc123.png)
 * @param {string} contentType
 * @returns {string} public URL
 */
async function uploadToCloudinary(fileBuffer, fileName, folder) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                public_id: fileName, // acts like path
                resource_type: "auto", // auto detect image/pdf/video
                folder: folder, // optional if you want folder separation
            },
            (error, result) => {
                if (error) {
                    return reject(new Error(`Cloudinary upload failed: ${error.message}`));
                }
                resolve(result.secure_url); // HTTPS URL
            }
        );

        streamifier.createReadStream(fileBuffer).pipe(uploadStream);
    });
}

/**
 * Delete file from Cloudinary
 * @param {string} fileName (same public_id used during upload)
 */
async function deleteFromCloudinary(fileName) {
    try {
        await cloudinary.uploader.destroy(fileName, {
            resource_type: "auto",
        });
    } catch (err) {
        console.error("Cloudinary delete error:", err.message);
    }
}

export { uploadToCloudinary, deleteFromCloudinary };