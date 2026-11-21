'use strict';

// Fábrica única de armazenamento. O padrão continua sendo o Vercel Blob para
// não mudar a produção atual; local e S3 são opt-in por STORAGE_PROVIDER.

const provider = String(process.env.STORAGE_PROVIDER || 'blob').trim().toLowerCase();

let sdk = null;
if (provider === 'local') sdk = require('./local-storage');
else if (provider === 's3') sdk = require('./s3-storage');

module.exports = { provider, sdk };
