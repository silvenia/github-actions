jest.mock('@actions/core');
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/lib-storage');

import * as core from '@actions/core';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  S3Config,
  getS3Config,
  statCacheObject,
  listCacheObjects,
  putCacheObject,
  downloadCacheObject,
  deleteCacheObject
} from '../src/s3';

const config: S3Config = {
  endpoint: 'https://s3.example.com',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  region: 'us-east-1',
  bucket: 'bucket',
  forcePathStyle: true,
  chunkSize: 10485760
};

const sendMock = jest.fn();
(S3Client as unknown as jest.Mock).mockImplementation(() => ({
  send: sendMock,
  destroy: jest.fn()
}));

beforeEach(() => {
  jest.clearAllMocks();
  sendMock.mockReset();
});

describe('getS3Config', () => {
  it('reads inputs with defaults', () => {
    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 's3-endpoint':
          return 'https://s3.example.com';
        case 's3-access-key':
          return 'key';
        case 's3-secret-key':
          return 'secret';
        case 's3-bucket':
          return 'bucket';
        default:
          return '';
      }
    });

    const cfg = getS3Config();
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.forcePathStyle).toBe(true);
    expect(cfg.chunkSize).toBe(10485760);
  });
});

describe('statCacheObject', () => {
  it('returns the object with parsed metadata', async () => {
    sendMock.mockResolvedValue({
      Metadata: { 'cache-version': 'abc', 'cache-format': '7z', 'cache-platform': 'linux', 'cache-size': '123' },
      ContentLength: 123,
      LastModified: new Date('2024-01-01T00:00:00.000Z')
    });

    const result = await statCacheObject(config, 'key1');
    expect(result).toEqual({
      key: 'key1',
      metadata: { cacheVersion: 'abc', format: '7z', platform: 'linux', size: 123 },
      size: 123,
      lastModified: new Date('2024-01-01T00:00:00.000Z')
    });
    expect(sendMock).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
  });

  it('returns null when the object does not exist', async () => {
    sendMock.mockRejectedValue({ name: 'NotFound' });
    await expect(statCacheObject(config, 'key1')).resolves.toBeNull();
  });

  it('rethrows other errors', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    await expect(statCacheObject(config, 'key1')).rejects.toThrow('boom');
  });
});

describe('listCacheObjects', () => {
  it('lists objects sorted by last modified descending', async () => {
    sendMock.mockResolvedValue({
      Contents: [
        { Key: 'old', Size: 1, LastModified: new Date('2024-01-01T00:00:00.000Z') },
        { Key: 'new', Size: 2, LastModified: new Date('2024-02-01T00:00:00.000Z') }
      ]
    });

    const result = await listCacheObjects(config, 'linux-npm-');
    expect(result.map(o => o.key)).toEqual(['new', 'old']);
    expect(sendMock).toHaveBeenCalledWith(expect.any(ListObjectsV2Command));
  });
});

describe('putCacheObject', () => {
  it('uploads with metadata via the managed multipart upload', async () => {
    const doneMock = jest.fn().mockResolvedValue(undefined);
    (Upload as unknown as jest.Mock).mockImplementation(() => ({ done: doneMock }));
    const archivePath = path.join(os.tmpdir(), `put-test-${process.pid}.bin`);
    fs.writeFileSync(archivePath, 'archive-data');

    try {
      await putCacheObject(config, 'key1', archivePath, {
        cacheVersion: 'abc',
        format: '7z',
        platform: 'linux',
        size: 12
      });

      expect(Upload).toHaveBeenCalledWith(
        expect.objectContaining({
          partSize: 10485760,
          params: expect.objectContaining({
            Bucket: 'bucket',
            Key: 'key1',
            Metadata: expect.objectContaining({
              'cache-version': 'abc',
              'cache-format': '7z',
              'cache-platform': 'linux',
              'cache-size': '12'
            })
          })
        })
      );
      expect(doneMock).toHaveBeenCalled();
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  });
});

describe('downloadCacheObject', () => {
  it('streams the object body to the destination file', async () => {
    sendMock.mockResolvedValue({ Body: Readable.from(['downloaded-data']) });
    const dest = path.join(os.tmpdir(), `dl-test-${process.pid}.bin`);

    try {
      await downloadCacheObject(config, 'key1', dest);
      expect(fs.readFileSync(dest, 'utf8')).toBe('downloaded-data');
      expect(sendMock).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    } finally {
      fs.rmSync(dest, { force: true });
    }
  });
});

describe('deleteCacheObject', () => {
  it('deletes the object', async () => {
    sendMock.mockResolvedValue({});
    await deleteCacheObject(config, 'key1');
    expect(sendMock).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
  });
});
