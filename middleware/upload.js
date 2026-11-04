const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
require('dotenv').config();

// S3 Client configuration for Cloudflare R2
const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// Multer upload setup using multer-s3 for Cloudflare R2
const upload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: process.env.R2_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE, // PDF, images, docx waghera ko automatic detect karega
        key: function (req, file, cb) {
            // Unique file name generate karna taake naam aapas mein na takrayen
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'uploads/' + uniqueSuffix + '-' + file.originalname);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 } // File size limit (10MB)
});

module.exports = upload;