jest.mock('@actions/core');
import * as core from '@actions/core';
import * as os from 'os';
import * as path from 'path';
import * as s3 from '../src/s3';
import * as cache from '../src/cache';
import { CompressionMethod } from '../src/utils';
import { saveCache } from '../src/save';

const tempDir = path.join(os.tmpdir(), 'save-test-temp');
const archivePath = path.join(tempDir, 'cache.tgz');
const CACHE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024;

function cacheObject(key: string): s3.CacheObject {
  return {
    key,
    metadata: {
      cacheKey: key,
      cacheVersion: 'v1',
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

  process.env.INPUT_S3_ENDPOINT = 'http://localhost:9000';
  process.env.INPUT_S3_ACCESS_KEY = 'minioadmin';
  process.env.INPUT_S3_SECRET_KEY = 'minioadmin';
  process.env.INPUT_S3_BUCKET = 'cache';
  process.env.INPUT_S3_PATH_STYLE = 'true';
  process.env.INPUT_UPLOAD_CHUNK_SIZE = '10485760';

  jest.spyOn(require('../src/utils'), 'getCompressionMethod').mockResolvedValue(
    CompressionMethod.Gzip
  );
  jest.spyOn(cache, 'resolvePaths').mockResolvedValue(['file1.txt']);
  jest.spyOn(cache, 'createTempDirectory').mockResolvedValue(tempDir);
  jest.spyOn(cache, 'createTar').mockResolvedValue(archivePath);
  jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(100);
  jest.spyOn(s3, 'putCacheObject').mockResolvedValue();
});

describe('saveCache', () => {
  it('skips saving when a cache with the same key already exists', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(cacheObject('key1'));

    const result = await saveCache('key1', ['file1.txt'], false);

    expect(result).toBeUndefined();
    expect(s3.putCacheObject).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('Cache already exists with key key1, not saving cache.');
  });

  it('creates a tar archive and uploads it with metadata', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(null);
    jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(123);

    const result = await saveCache('key1', ['file1.txt'], false);

    expect(result).toBe('key1');
    expect(cache.createTar).toHaveBeenCalledWith(tempDir, ['file1.txt'], CompressionMethod.Gzip);
    expect(s3.putCacheObject).toHaveBeenCalledWith(
      expect.anything(),
      'key1',
      archivePath,
      expect.objectContaining({
        cacheKey: 'key1',
        platform: process.platform,
        size: 123
      })
    );
    expect(core.info).toHaveBeenCalledWith('Cache saved with key: key1');
  });

  it('throws when the archive exceeds the 5 GB size limit', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(null);
    jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(CACHE_SIZE_LIMIT + 1);

    await expect(saveCache('key1', ['file1.txt'], false)).rejects.toThrow('5GB limit');
    expect(s3.putCacheObject).not.toHaveBeenCalled();
  });
});
