import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as crypto from 'crypto';

export enum CompressionMethod {
  Gzip = 'gzip',
  Zstd = 'zstd',
  ZstdWithoutLong = 'zstd-without-long'
}

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

export async function getCompressionMethod(): Promise<CompressionMethod> {
  let versionOutput = '';
  // `input` must be truthy: @actions/exec only calls cp.stdin.end() when
  // options.input is set, otherwise zstd blocks forever reading the open
  // stdin pipe.
  await exec.exec('zstd', ['--quiet'], {
    ignoreReturnCode: true,
    silent: true,
    input: Buffer.from('\n'),
    listeners: {
      stdout: (data: Buffer): string => (versionOutput += data.toString()),
      stderr: (data: Buffer): string => (versionOutput += data.toString())
    }
  });
  return versionOutput.trim() === '' ? CompressionMethod.Gzip : CompressionMethod.ZstdWithoutLong;
}

export function getCacheFileName(compressionMethod: CompressionMethod): string {
  return compressionMethod === CompressionMethod.Gzip ? 'cache.tgz' : 'cache.tzst';
}

export function getCacheVersion(
  paths: string[],
  compressionMethod: CompressionMethod | undefined,
  enableCrossOsArchive: boolean
): string {
  const versionSalt = '1.0';
  const components = [...paths];

  if (compressionMethod) {
    components.push(compressionMethod);
  }
  if (process.platform === 'win32' && !enableCrossOsArchive) {
    components.push('windows-only');
  }
  components.push(versionSalt);

  return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}
