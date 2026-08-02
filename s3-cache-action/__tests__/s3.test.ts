jest.mock('@actions/exec');
jest.mock('@actions/core');
import * as exec from '@actions/exec';
import {
  S3Config,
  buildRcloneEnv,
  deleteCacheObject,
  downloadCacheObject,
  execRclone,
  listCacheObjects,
  putCacheObject,
  remote,
  statCacheObject
} from '../src/s3';

const config: S3Config = {
  endpoint: 'https://s3.example.com',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  bucket: 'bucket',
  forcePathStyle: true
};

function mockExec(exitCode: number, stdout: string = '', stderr: string = ''): jest.Mock {
  return (exec.exec as jest.Mock).mockImplementation(
    async (_commandLine: string, _args: string[], options?: any) => {
      if (options?.listeners?.stdout) {
        options.listeners.stdout(Buffer.from(stdout));
      }
      if (options?.listeners?.stderr) {
        options.listeners.stderr(Buffer.from(stderr));
      }
      return exitCode;
    }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildRcloneEnv', () => {
  it('configures the s3 remote with path-style addressing when forcePathStyle is true', () => {
    const env = buildRcloneEnv(config);
    expect(env).toMatchObject({
      RCLONE_CONFIG_S3_TYPE: 's3',
      RCLONE_CONFIG_S3_PROVIDER: 'Other',
      RCLONE_CONFIG_S3_ENDPOINT: 'https://s3.example.com',
      RCLONE_CONFIG_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: 'secret',
      RCLONE_CONFIG_S3_REGION: 'us-east-1',
      RCLONE_CONFIG_S3_FORCE_PATH_STYLE: 'true',
      RCLONE_CONFIG_S3_NO_CHECK_BUCKET: 'true'
    });
  });

  it('uses virtual-hosted-style addressing when forcePathStyle is false', () => {
    const env = buildRcloneEnv({ ...config, forcePathStyle: false });
    expect(env.RCLONE_CONFIG_S3_FORCE_PATH_STYLE).toBe('false');
  });
});

describe('remote', () => {
  it('builds the rclone remote path', () => {
    expect(remote(config, 'key1')).toBe('s3:bucket/key1');
  });
});

describe('execRclone', () => {
  it('merges process.env with the rclone config environment', async () => {
    mockExec(0);
    await execRclone(['stat', 's3:bucket/key1'], config);

    expect(exec.exec).toHaveBeenCalledWith(
      'rclone',
      ['stat', 's3:bucket/key1'],
      expect.objectContaining({
        env: expect.objectContaining({
          ...process.env,
          RCLONE_CONFIG_S3_TYPE: 's3',
          RCLONE_CONFIG_S3_ENDPOINT: 'https://s3.example.com'
        })
      })
    );
  });

  it('captures stdout, stderr and exit code from the exec listeners', async () => {
    mockExec(4, 'out-text', 'err-text');
    const result = await execRclone(['stat', 's3:bucket/key1'], config);

    expect(result).toEqual({ exitCode: 4, stdout: 'out-text', stderr: 'err-text' });
  });
});

describe('putCacheObject', () => {
  it('builds the multipart upload arguments with metadata', async () => {
    mockExec(0);
    await putCacheObject(config, 'key1', '/tmp/cache.tgz', {
      cacheKey: 'key1',
      cacheVersion: 'v1',
      platform: 'linux',
      size: 123
    });

    expect(exec.exec).toHaveBeenCalledWith(
      'rclone',
      [
        'copyto',
        '/tmp/cache.tgz',
        's3:bucket/key1',
        '--s3-upload-cutoff',
        '0',
        '--s3-chunk-size',
        '10485760',
        '--s3-upload-concurrency',
        '4',
        '--metadata',
        '--metadata-set',
        'cache-key=key1',
        '--metadata-set',
        'cache-version=v1',
        '--metadata-set',
        'cache-platform=linux',
        '--metadata-set',
        'cache-size=123',
        '--quiet'
      ],
      expect.anything()
    );
  });

  it('throws with stderr on a non-zero exit code', async () => {
    mockExec(1, '', 'boom');
    await expect(
      putCacheObject(config, 'key1', '/tmp/cache.tgz', {
        cacheKey: 'key1',
        cacheVersion: 'v1',
        platform: 'linux',
        size: 123
      })
    ).rejects.toThrow('boom');
  });
});

describe('statCacheObject', () => {
  const statJson = JSON.stringify([
    {
      Path: 'key1',
      Name: 'key1',
      Size: 12345,
      ModTime: '2024-01-01T00:00:00.000Z',
      IsDir: false,
      Metadata: {
        'cache-key': 'key1',
        'cache-version': 'abc123',
        'cache-platform': 'linux',
        'cache-size': '12345'
      }
    }
  ]);

  it('parses a hit into a CacheObject', async () => {
    mockExec(0, statJson);
    const obj = await statCacheObject(config, 'key1');

    expect(exec.exec).toHaveBeenCalledWith(
      'rclone',
      ['lsjson', 's3:bucket/key1', '--files-only', '--metadata', '--quiet'],
      expect.anything()
    );
    expect(obj).not.toBeNull();
    expect(obj!.key).toBe('key1');
    expect(obj!.metadata).toEqual({
      cacheKey: 'key1',
      cacheVersion: 'abc123',
      platform: 'linux',
      size: 12345
    });
    expect(obj!.size).toBe(12345);
    expect(obj!.lastModified).toEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('returns null when the object does not exist (empty listing)', async () => {
    mockExec(0, '[]');
    const obj = await statCacheObject(config, 'key1');
    expect(obj).toBeNull();
  });

  it('throws with stderr on other non-zero exit codes', async () => {
    mockExec(5, '', 'bad config');
    await expect(statCacheObject(config, 'key1')).rejects.toThrow('bad config');
  });
});

describe('downloadCacheObject', () => {
  it('invokes copyto with the remote and destination', async () => {
    mockExec(0);
    await downloadCacheObject(config, 'key1', '/tmp/cache.tgz');

    expect(exec.exec).toHaveBeenCalledWith(
      'rclone',
      ['copyto', 's3:bucket/key1', '/tmp/cache.tgz', '--quiet'],
      expect.anything()
    );
  });

  it('throws with stderr on a non-zero exit code', async () => {
    mockExec(1, '', 'no such object');
    await expect(downloadCacheObject(config, 'key1', '/tmp/cache.tgz')).rejects.toThrow(
      'no such object'
    );
  });
});

describe('listCacheObjects', () => {
  const lsjson = JSON.stringify([
    {
      Path: 'other-key',
      Name: 'other-key',
      Size: 300,
      ModTime: '2024-01-03T00:00:00.000Z',
      Metadata: {
        'cache-key': 'other-key',
        'cache-version': 'v1',
        'cache-platform': 'linux',
        'cache-size': '300'
      }
    },
    {
      Path: 'linux-npm-bbb',
      Name: 'linux-npm-bbb',
      Size: 200,
      ModTime: '2024-01-01T00:00:00.000Z',
      Metadata: {
        'cache-key': 'linux-npm-bbb',
        'cache-version': 'v1',
        'cache-platform': 'linux',
        'cache-size': '200'
      }
    },
    {
      Path: 'linux-npm-aaa',
      Name: 'linux-npm-aaa',
      Size: 100,
      ModTime: '2024-01-02T00:00:00.000Z',
      Metadata: {
        'cache-key': 'linux-npm-aaa',
        'cache-version': 'v1',
        'cache-platform': 'linux',
        'cache-size': '100'
      }
    }
  ]);

  it('lists the bucket root and filters by prefix, sorted by lastModified descending', async () => {
    mockExec(0, lsjson);
    const objects = await listCacheObjects(config, 'linux-npm-');

    expect(exec.exec).toHaveBeenCalledWith(
      'rclone',
      ['lsjson', 's3:bucket', '--files-only', '--metadata', '--quiet'],
      expect.anything()
    );
    expect(objects.map(o => o.key)).toEqual(['linux-npm-aaa', 'linux-npm-bbb']);
  });

  it('maps metadata from each entry', async () => {
    mockExec(0, lsjson);
    const objects = await listCacheObjects(config, 'linux-npm-');

    expect(objects[0].metadata).toEqual({
      cacheKey: 'linux-npm-aaa',
      cacheVersion: 'v1',
      platform: 'linux',
      size: 100
    });
    expect(objects[0].size).toBe(100);
  });

  it('returns an empty array when no objects match the prefix', async () => {
    mockExec(0, lsjson);
    const objects = await listCacheObjects(config, 'zzz-no-match-');
    expect(objects).toEqual([]);
  });

  it('throws with stderr on a non-zero exit code', async () => {
    mockExec(2, '', 'access denied');
    await expect(listCacheObjects(config, 'linux-npm-')).rejects.toThrow('access denied');
  });
});

describe('deleteCacheObject', () => {
  it('invokes deletefile with the remote', async () => {
    mockExec(0);
    await deleteCacheObject(config, 'key1');

    expect(exec.exec).toHaveBeenCalledWith(
      'rclone',
      ['deletefile', 's3:bucket/key1', '--quiet'],
      expect.anything()
    );
  });
});
