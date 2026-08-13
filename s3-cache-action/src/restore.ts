import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { S3Config, statCacheObject, downloadCacheObject, listCacheObjects } from './s3';
import { createTempDirectory, extractCacheArchive, getArchiveFileSizeInBytes } from './cache';
import { CACHE_FILE_NAME, getCacheVersion, isExactKeyMatch, validateKey, validatePaths } from './utils';

export async function restoreCache(
  primaryKey: string,
  restoreKeys: string[],
  paths: string[],
  enableCrossOsArchive: boolean,
  failOnCacheMiss: boolean,
  config: S3Config
): Promise<string | undefined> {
  validateKey(primaryKey);
  validatePaths(paths);

  const cacheVersion = getCacheVersion(paths, enableCrossOsArchive);
  core.debug(`Cache version: ${cacheVersion}`);

  const keysToSearch = [primaryKey, ...restoreKeys];
  core.debug(`Keys to search: ${JSON.stringify(keysToSearch)}`);

  let matchedKey: string | undefined;

  for (const key of keysToSearch) {
    const hit = await statCacheObject(config, key);
    if (hit && hit.metadata.cacheVersion === cacheVersion) {
      matchedKey = key;
      break;
    }
    if (hit && key === primaryKey) {
      core.info(
        `Cache entry ${key} exists but was written by an incompatible action version, ignoring it.`
      );
    }
    if (key !== primaryKey) {
      const matches = await listCacheObjects(config, key);
      for (const candidate of matches) {
        const candidateHit = await statCacheObject(config, candidate.key);
        if (candidateHit && candidateHit.metadata.cacheVersion === cacheVersion) {
          matchedKey = candidate.key;
          break;
        }
      }
      if (matchedKey) {
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
  const archivePath = path.join(tempDir, CACHE_FILE_NAME);
  try {
    await downloadCacheObject(config, matchedKey, archivePath);

    const archiveFileSize = getArchiveFileSizeInBytes(archivePath);
    core.info(`Cache Size: ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B)`);

    await extractCacheArchive(archivePath);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
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
