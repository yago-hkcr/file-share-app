'use strict';

const BLOB_PATH_PREFIXES = ['rooms/', 'dm/', 'collections/', 'library/'];

function isBlobPath(name) {
  return typeof name === 'string' && BLOB_PATH_PREFIXES.some(prefix => name.startsWith(prefix));
}

module.exports = { isBlobPath };