import * as core from '@actions/core';
import * as fs from 'fs';
import { S3Config, statCacheObject, putCacheObject } from './s3';
import { createCacheArchive, createTempDirectory, getArchiveFileSizeInBytes, resolvePaths } from './cache';
import { ARCHIVE_FORMAT, getCacheVersion, validateKey, validatePaths } from './utils';

const CACHE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB

export async function saveCache(
  primaryKey: string,
  paths: string[],
  enableCrossOsArchive: boolean,
  config: S3Config
): Promise<string | void> {
  validateKey(primaryKey);
  validatePaths(paths);

  if (await statCacheObject(config, primaryKey)) {
    core.info(`Cache already exists with key ${primaryKey}, not saving cache.`);
    return;
  }

  const resolvedPaths = await resolvePaths(paths);
  core.debug(`Resolved Cache Paths: ${JSON.stringify(resolvedPaths)}`);

  const cacheVersion = getCacheVersion(resolvedPaths, enableCrossOsArchive);

  const tempDir = await createTempDirectory();
  let archivePath: string;
  try {
    archivePath = await createCacheArchive(tempDir, resolvedPaths);
    const archiveFileSize = getArchiveFileSizeInBytes(archivePath);
    core.debug(`File Size: ${archiveFileSize}`);

    if (archiveFileSize > CACHE_SIZE_LIMIT) {
      throw new Error(
        `Cache size of ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B) is over the 5GB limit, not saving cache.`
      );
    }

    await putCacheObject(config, primaryKey, archivePath, {
      cacheVersion,
      format: ARCHIVE_FORMAT,
      platform: process.platform,
      size: archiveFileSize
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  core.info(`Cache saved with key: ${primaryKey}`);
  return primaryKey;
}
