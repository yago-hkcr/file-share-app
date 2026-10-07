const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { once } = require('events');

const IS_VERCEL = Boolean(process.env.VERCEL);

// ---------------------------------------------------------------------------
// VariÃ¡veis de ambiente (localmente lÃª o .env.local; na Vercel jÃ¡ vÃªm prontas)
// ---------------------------------------------------------------------------
if (!IS_VERCEL) {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}

const LOCAL_MODE = !IS_VERCEL && process.env.FILESHARE_LOCAL === '1';
const LOCAL_DATA_DIR = path.resolve(process.env.FILESHARE_DATA_DIR || path.join(__dirname, 'data', 'local'));
const LOCAL_LAN_PORT = Number(process.env.FILESHARE_LAN_PORT || Number(process.env.PORT || 3000)¶»§q«^