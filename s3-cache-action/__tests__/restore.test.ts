jest.mock('@actions/core');
import * as core from '@actions/core';
import * as os from 'os';
import * as path from 'path';
import * as s3 from '../src/s3';
import * as cache from '../src/cache';
import { getCacheVersion } from '../src/utils';
import { restoreCache } from '../src/restore';

const tempDir = path.join(os.tmpdir(), 'restore-test-temp');
const config: s3.S3Config = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  region: 'us-east-1',
  bucket: 'cache',
  forcePathStyle: true
};

const PATHS = ['p1'];
const VERSION = getCacheVersion(PATHS, false);

function cacheObject(key: string, cacheVersion: string = VERSION): s3.CacheObject {
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

  jest.spyOn(cache, 'createTempDirectory').mockResolvedValue(tempDir);
  jest.spyOn(cache, 'getArchiveFileSizeInBytes').mockReturnValue(100);
  jest.spyOn(cache, 'extractCacheArchive').mockResolvedValue();
  jest.spyOn(s3, 'downloadCacheObject').mockResolvedValue();
});

describe('restoreCache', () => {
  it('restores on an exact key hit and sets cache-hit to true', async () => {
    jest.spyOn(s3, 'statCacheObject').mockImplementation(async (_config, key) =>
      key === 'key1' ? cacheObject('key1') : null
    );

    const result = await restoreCache('key1', [], PATHS, false, false, config);

    expect(result).toBe('key1');
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'true');
    expect(core.setOutput).toHaveBeenCalledWith('cache-matched-key', 'key1');
    expect(core.setOutput).toHaveBeenCalledWith('cache-primary-key', 'key1');
    expect(s3.downloadCacheObject).toHaveBeenCalledWith(
      expect.anything(),
      'key1',
      path.join(tempDir, 'cache.7z')
    );
    expect(cache.extractCacheArchive).toHaveBeenCalledWith(path.join(tempDir, 'cache.7z'));
  });

  it('ignores an exact key object written by an incompatible action version', async () => {
    jest.spyOn(s3, 'statCacheObject').mockImplementation(async (_config, key) =>
      key === 'key1' ? cacheObject('key1', 'stale-version') : null
    );
    jest.spyOn(s3, 'listCacheObjects').mockResolvedValue([]);

    const result = await restoreCache('key1', [], PATHS, false, false, config);

    expect(result).toBeUndefined();
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'false');
    expect(s3.downloadCacheObject).not.toHaveBeenCalled();
  });

  it('restores via a prefix restore-key match and sets cache-hit to false', async () => {
    jest.spyOn(s3, 'statCacheObject').mockImplementation(async (_config, key) =>
      key === 'linux-npm-abc123' ? cacheObject('linux-npm-abc123') : null
    );
    jest.spyOn(s3, 'listCacheObjects').mockResolvedValue([cacheObject('linux-npm-abc123')]);

    const result = await restoreCache('linux-npm-def456', ['linux-npm-'], PATHS, false, false, config);

    expect(result).toBe('linux-npm-abc123');
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'false');
    expect(core.setOutput).toHaveBeenCalledWith('cache-matched-key', 'linux-npm-abc123');
    expect(core.setOutput).toHaveBeenCalledWith('cache-primary-key', 'linux-npm-def456');
  });

  it('skips prefix matches written by an incompatible action version', async () => {
    jest.spyOn(s3, 'statCacheObject').mockImplementation(async (_config, key) =>
      key === 'linux-npm-abc123' ? cacheObject('linux-npm-abc123', 'stale-version') : null
    );
    jest.spyOn(s3, 'listCacheObjects').mockResolvedValue([cacheObject('linux-npm-abc123')]);

    const result = await restoreCache('linux-npm-def456', ['linux-npm-'], PATHS, false, false, config);

    expect(result).toBeUndefined();
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'false');
  });

  it('returns undefined on a miss without failOnCacheMiss', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(null);
    jest.spyOn(s3, 'listCacheObjects').mockResolvedValue([]);

    const result = await restoreCache('key1', [], PATHS, false, false, config);

    expect(result).toBeUndefined();
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'false');
    expect(core.setOutput).toHaveBeenCalledWith('cache-primary-key', 'key1');
    expect(core.setOutput).not.toHaveBeenCalledWith('cache-matched-key', expect.anything());
  });

  it('throws with a fail-on-cache-miss message when failOnCacheMiss is set', async () => {
    jest.spyOn(s3, 'statCacheObject').mockResolvedValue(null);
    jest.spyOn(s3, 'listCacheObjects').mockResolvedValue([]);

    await expect(restoreCache('key1', [], PATHS, false, true, config)).rejects.toThrow(
      'fail-on-cache-miss'
    );
  });
});
