import * as core from '@actions/core';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ARCHIVE_FORMAT } from './utils';

export interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  // true = path-style addressing (default); false = virtual-hosted-style addressing
  forcePathStyle: boolean;
  // multipart chunk size in bytes (default 10 MiB)
  chunkSize?: number;
}

export interface CacheObjectMetadata {
  cacheVersion: string;
  format: string;
  platform: string;
  size: number;
}

export interface CacheObject {
  key: string;
  metadata: CacheObjectMetadata;
  size: number;
  lastModified: Date;
}

/** Build the S3 client configuration from the action inputs. */
export function getS3Config(): S3Config {
  return {
    endpoint: core.getInput('s3-endpoint', { required: true }),
    accessKeyId: core.getInput('s3-access-key', { required: true }),
    secretAccessKey: core.getInput('s3-secret-key', { required: true }),
    bucket: core.getInput('s3-bucket', { required: true }),
    // Defaults to path-style (true); any value other than the exact string 'false' enables it
    forcePathStyle: core.getInput('s3-path-style') !== 'false',
    region: core.getInput('s3-region') || 'us-east-1',
    chunkSize: parseInt(core.getInput('upload-chunk-size') || '10485760', 10)
  };
}

function makeClient(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 2
  });
}

function parseMetadata(metadata: Record<string, string> | undefined): CacheObjectMetadata {
  return {
    cacheVersion: metadata?.['cache-version'] || '',
    format: metadata?.['cache-format'] || ARCHIVE_FORMAT,
    platform: metadata?.['cache-platform'] || '',
    size: parseInt(metadata?.['cache-size'] || '0', 10) || 0
  };
}

export async function putCacheObject(
  config: S3Config,
  key: string,
  archivePath: string,
  metadata: CacheObjectMetadata
): Promise<void> {
  const chunkSize = config.chunkSize || 10 * 1024 * 1024;
  core.debug(`Uploading cache archive to s3://${config.bucket}/${key}`);

  const client = makeClient(config);
  const body = fs.createReadStream(archivePath);
  // A ReadStream schedules its open asynchronously; swallow any late open
  // error (e.g. the archive is cleaned up after the upload) so it cannot
  // surface as an unhandled error on a later test/step.
  body.on('error', () => {});
  try {
    const upload = new Upload({
      client,
      partSize: chunkSize,
      queueSize: 4,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: body,
        Metadata: {
          'cache-version': metadata.cacheVersion,
          'cache-format': metadata.format,
          'cache-platform': metadata.platform,
          'cache-size': String(metadata.size)
        }
      }
    });
    await upload.done();
  } finally {
    // Ensure the lazy stream open never outlives this function (a dangling
    // open can fail after the archive is cleaned up).
    body.destroy();
    client.destroy();
  }
  core.debug(`Cache archive uploaded successfully: ${key}`);
}

export async function statCacheObject(config: S3Config, key: string): Promise<CacheObject | null> {
  const client = makeClient(config);
  try {
    const out = await client.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: key })
    );
    return {
      key,
      metadata: parseMetadata(out.Metadata),
      size: out.ContentLength || 0,
      lastModified: out.LastModified || new Date(0)
    };
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFound') {
      return null;
    }
    throw error;
  } finally {
    client.destroy();
  }
}

export async function downloadCacheObject(
  config: S3Config,
  key: string,
  destPath: string
): Promise<void> {
  const client = makeClient(config);
  try {
    const out = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key })
    );
    const body = out.Body as unknown as NodeJS.ReadableStream;
    await pipeline(body, fs.createWriteStream(destPath));
  } finally {
    client.destroy();
  }
}

export async function listCacheObjects(
  config: S3Config,
  prefix: string
): Promise<CacheObject[]> {
  const client = makeClient(config);
  try {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix })
    );
    const objects: CacheObject[] = (out.Contents || []).map(entry => ({
      key: entry.Key || '',
      metadata: parseMetadata(undefined),
      size: entry.Size || 0,
      lastModified: entry.LastModified || new Date(0)
    }));
    return objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  } finally {
    client.destroy();
  }
}

export async function deleteCacheObject(config: S3Config, key: string): Promise<void> {
  const client = makeClient(config);
  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key })
    );
  } finally {
    client.destroy();
  }
}
