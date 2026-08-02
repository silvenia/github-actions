import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { S3Config, statCacheObject, downloadCacheObject, listCacheObjects } from './s3';
import { extractTar, createTempDirectory, getArchiveFileSizeInBytes } from './cache';
import {
  CompressionMethod,
  getCompressionMethod,
  getCacheFileName,
  getCacheVersion,
  isExactKeyMatch,
  validateKey,
  validatePaths
} from './utils';

export async function restoreCache(
  primaryKey: string,
  restoreKeys: string[],
  paths: string[],
  enableCrossOsArchive: boolean,
  failOnCacheMiss: boolean
): Promise<string | undefined> {
  validateKey(primaryKey);
  validatePaths(paths);

  const compressionMethod: CompressionMethod = await getCompressionMethod();
  const cacheVersion = getCacheVersion(paths, compressionMethod, enableCrossOsArchive);
  core.debug(`Compression method: ${compressionMethod}`);
  core.debug(`Cache version: ${cacheVersion}`);

  const config: S3Config = {
    endpoint: process.env.INPUT_S3_ENDPOINT!,
    accessKeyId: process.env.INPUT_S3_ACCESS_KEY!,
    secretAccessKey: process.env.INPUT_S3_SECRET_KEY!,
    bucket: process.env.INPUT_S3_BUCKET!,
    // Defaults to path-style (true); any value other than the exact string 'false' enables it
    forcePathStyle: process.env.INPUT_S3_PATH_STYLE !== 'false'
  };

  const keysToSearch = [primaryKey, ...restoreKeys];
  core.debug(`Keys to search: ${JSON.stringify(keysToSearch)}`);

  let matchedKey: string | undefined;

  for (const key of keysToSearch) {
    const hit = await statCacheObject(config, key);
    if (hit) {
      matchedKey = key;
      break;
    }
    if (key !== primaryKey) {
      const matches = await listCacheObjects(config, key);
      if (matches.length > 0) {
        matchedKey = matches[0].key;
        break;
      }
    }
  }

  if (!matchedKey) {
    core.info(`Cache not found for input keys: ${keysToSearch.join(', ')}`);
    core.setOutput('cache-hit', 'false');
    core.setOutput('cache-primary-key', primaryKey);
    if (failOnCacheMiss) {
      throw new Error(
        `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${primaryKey}`
      );
    }
    return undefined;
  }

  const tempDir = await createTempDirectory();
  const archivePath = path.join(tempDir, getCacheFileName(compressionMethod));
  await downloadCacheObject(config, matchedKey, archivePath);

  const archiveFileSize = getArchiveFileSizeInBytes(archivePath);
  core.info(`Cache Size: ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B)`);

  try {
    await extractTar(archivePath, compressionMethod);
  } finally {
    try {
      fs.unlinkSync(archivePath);
    } catch (error) {
      core.debug(`Failed to delete archive: ${error}`);
    }
  }

  const isExact = isExactKeyMatch(primaryKey, matchedKey);
  core.setOutput('cache-hit', isExact.toString());
  core.setOutput('cache-matched-key', matchedKey);
  core.setOutput('cache-primary-key', primaryKey);
  core.info(`Cache restored from key: ${matchedKey}`);

  return matchedKey;
}
