import * as core from '@actions/core';
import * as crypto from 'crypto';

/** Archive format produced by this version of the action (7-Zip, LZMA2). */
export const ARCHIVE_FORMAT = '7z';

/** Name of the archive file within the temporary directory. */
export const CACHE_FILE_NAME = 'cache.7z';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export function isExactKeyMatch(key: string, cacheKey: string | undefined): boolean {
  return !!(cacheKey && cacheKey.localeCompare(key, undefined, { sensitivity: 'accent' }) === 0);
}

export function getInputAsArray(name: string): string[] {
  return core
    .getInput(name)
    .split('\n')
    .map(s => s.replace(/^!\s+/, '!').trim())
    .filter(x => x !== '');
}

export function getInputAsBool(name: string): boolean {
  return core.getInput(name).toLowerCase() === 'true';
}

export function getInputAsInt(name: string): number | undefined {
  const value = parseInt(core.getInput(name));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function logWarning(message: string): void {
  core.info(`[warning]${message}`);
}

export function validateKey(key: string): void {
  if (!key) {
    throw new ValidationError('Key is not specified.');
  }
  if (key.length > 512) {
    throw new ValidationError(`${key} cannot be larger than 512 characters.`);
  }
  if (/,/.test(key)) {
    throw new ValidationError(`${key} cannot contain commas.`);
  }
  if (/\/\//.test(key)) {
    throw new ValidationError(`${key} cannot contain consecutive forward slashes.`);
  }
}

export function validatePaths(paths: string[]): void {
  if (!paths || paths.length === 0) {
    throw new ValidationError('At least one directory or file path is required.');
  }
}

/**
 * Compute the cache version for the action implementation. The version is
 * stored as object metadata and matched on restore so that archives written
 * by older action versions (different format/compression) are never restored
 * or overwritten. The version intentionally does not depend on the cached
 * paths: the cache key already identifies the cache entry, and deriving the
 * version from paths makes it machine-dependent and non-portable.
 */
export function getCacheVersion(enableCrossOsArchive: boolean): string {
  const versionSalt = '2.0';
  const components = [ARCHIVE_FORMAT];

  if (process.platform === 'win32' && !enableCrossOsArchive) {
    components.push('windows-only');
  }
  components.push(versionSalt);

  return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}
