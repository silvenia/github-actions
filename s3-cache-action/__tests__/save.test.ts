jest.mock('@actions/core');
import * as core from '@actions/core';
import * as os from 'os';
import * as path from 'path';
import * as s3 from '../src/s3';
import * as cache from '../src/cache';
import { ARCHIVE_FORMAT, getCacheVersion } from '../src/utils';
import { saveCache } from '../src/save';

const tempDir = path.join(os.tmpdir(), 'save-test-temp');
const archivePath = path.join(tempDir, 'cache.7z');
const CACHE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024;

const config: s3.S3Config = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  region: 'us-east-1',
  bucket: 'cache',
  forcePathStyle: true
};

function cacheObject(key: string, cacheVersion = 'v1'): s3.CacheObject {
  return {
    key,
    metadata: {
      cacheVersion,
      format: '7z',
      platform: 'linux',
      size: 100
    },
    size: 100,
    lastModified: new Date('2024-01-01T00:00:00.000Z')
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();

  jest.spyOn(cache, 'resolvePaths').mockResolvedValue(['file1.txt']);
  jest.spyOn(cache, 'createTempDirectory').mockResolvedValue(tempDir);
  jest.spyOn(cache, 'createCacheArchive').mockResolvedValue(archivePath);
  jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(100);
  jest.spyOn(s3, 'putCacheObject').mockResolvedValue();
});

describe('saveCache', () => {
  it('skips saving when a compatible cache with the same key already exists', async () => {
    const cacheVersion = getCacheVersion(false);
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(cacheObject('key1', cacheVersion));

    const result = await saveCache('key1', ['file1.txt'], false, config);

    expect(result).toBeUndefined();
    expect(s3.putCacheObject).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('Cache already exists with key key1, not saving cache.');
  });

  it('overwrites an existing cache entry written by an incompatible version', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(cacheObject('key1', 'old-version'));

    const result = await saveCache('key1', ['file1.txt'], false, config);

    expect(result).toBe('key1');
    expect(s3.putCacheObject).toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      'Cache entry key1 exists but was written by an incompatible action version, overwriting it.'
    );
  });

  it('creates a 7z archive and uploads it with metadata', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(null);
    jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(123);

    const result = await saveCache('key1', ['file1.txt'], false, config);

    expect(result).toBe('key1');
    expect(cache.createCacheArchive).toHaveBeenCalledWith(tempDir, ['file1.txt']);
    expect(s3.putCacheObject).toHaveBeenCalledWith(
      expect.anything(),
      'key1',
      archivePath,
      expect.objectContaining({
        format: ARCHIVE_FORMAT,
        platform: process.platform,
        size: 123
      })
    );
    expect(core.info).toHaveBeenCalledWith('Cache saved with key: key1');
  });

  it('throws when the archive exceeds the 5 GB size limit', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(null);
    jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(CACHE_SIZE_LIMIT + 1);

    await expect(saveCache('key1', ['file1.txt'], false, config)).rejects.toThrow('5GB limit');
    expect(s3.putCacheObject).not.toHaveBeenCalled();
  });
});
