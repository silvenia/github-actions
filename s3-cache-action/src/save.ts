import * as core from '@actions/core';
import * as fs from 'fs';
import { S3Config, statCacheObject, putCacheObject } from './s3';
import { createTar, createTempDirectory, getArchiveFileSizeInBytes, resolvePaths } from './cache';
import {
  CompressionMethod,
  getCompressionMethod,
  getCacheVersion,
  validateKey,
  validatePaths
} from './utils';

const CACHE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB

export async function saveCache(
  primaryKey: string,
  paths: string[],
  enableCrossOsArchive: boolean
): Promise<string | void> {
  validateKey(primaryKey);
  validatePaths(paths);

  const config: S3Config = {
    endpoint: process.env.INPUT_S3_ENDPOINT!,
    accessKeyId: process.env.INPUT_S3_ACCESS_KEY!,
    secretAccessKey: process.env.INPUT_S3_SECRET_KEY!,
    bucket: process.env.INPUT_S3_BUCKET!,
    // Defaults to path-style (true); any value other than the exact string 'false' enables it
    forcePathStyle: process.env.INPUT_S3_PATH_STYLE !== 'false',
    chunkSize: parseInt(process.env.INPUT_UPLOAD_CHUNK_SIZE || '10485760', 10)
  };

  if (await statCacheObject(config, primaryKey)) {
    core.info(`Cache already exists with key ${primaryKey}, not saving cache.`);
    return;
  }

  const compressionMethod: CompressionMethod = await getCompressionMethod();
  const resolvedPaths = await resolvePaths(paths);
  core.debug(`Resolved Cache Paths: ${JSON.stringify(resolvedPaths)}`);

  const cacheVersion = getCacheVersion(resolvedPaths, compressionMethod, enableCrossOsArchive);

  const tempDir = await createTempDirectory();
  let archivePath: string;
  try {
    archivePath = await createTar(tempDir, resolvedPaths, compressionMethod);
    const archiveFileSize = getArchiveFileSizeInBytes(archivePath);
    core.debug(`File Size: ${archiveFileSize}`);

    if (archiveFileSize > CACHE_SIZE_LIMIT) {
      throw new Error(
        `Cache size of ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B) is over the 5GB limit, not saving cache.`
      );
    }

    await putCacheObject(config, primaryKey, archivePath, {
      cacheKey: primaryKey,
      cacheVersion,
      platform: process.platform,
      size: archiveFileSize
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  core.info(`Cache saved with key: ${primaryKey}`);
  return primaryKey;
}
