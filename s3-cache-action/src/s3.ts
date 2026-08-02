import * as core from '@actions/core';
import * as exec from '@actions/exec';

export interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket: string;
  // true = path-style addressing (default); false = virtual-hosted-style addressing
  forcePathStyle: boolean;
  // multipart chunk size in bytes (default 10 MiB); passed as --s3-chunk-size
  chunkSize?: number;
}

export interface CacheObjectMetadata {
  cacheKey: string;
  cacheVersion: string;
  platform: string;
  size: number;
}

export interface CacheObject {
  key: string;
  metadata: CacheObjectMetadata;
  size: number;
  lastModified: Date;
}

export function buildRcloneEnv(config: S3Config): Record<string, string> {
  return {
    RCLONE_CONFIG_S3_TYPE: 's3',
    RCLONE_CONFIG_S3_PROVIDER: 'Other',
    RCLONE_CONFIG_S3_ENDPOINT: config.endpoint,
    RCLONE_CONFIG_S3_ACCESS_KEY_ID: config.accessKeyId,
    RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    RCLONE_CONFIG_S3_REGION: config.region || 'us-east-1',
    RCLONE_CONFIG_S3_FORCE_PATH_STYLE: config.forcePathStyle ? 'true' : 'false',
    RCLONE_CONFIG_S3_NO_CHECK_BUCKET: 'true'
  };
}

export function remote(config: S3Config, key: string): string {
  // Reference the "s3" remote by NAME (not the anonymous `:s3:` backend-type
  // syntax): the `:s3:` form ignores the RCLONE_CONFIG_S3_* environment
  // variables, which would make every operation anonymous.
  return `s3:${config.bucket}/${key}`;
}

export async function execRclone(
  args: string[],
  config: S3Config
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  core.debug(`rclone ${args.join(' ')}`);
  let stdout = '';
  let stderr = '';
  const exitCode = await exec.exec(
    'rclone',
    [
      // Fail fast on unreachable endpoints: the AWS SDK backoff inside rclone
      // retries connection errors for minutes on end by default.
      '--retries',
      '2',
      '--low-level-retries',
      '2',
      ...args
    ],
    {
      ignoreReturnCode: true,
      silent: true,
      env: { ...process.env, ...buildRcloneEnv(config) } as { [key: string]: string },
      listeners: {
        stdout: (data: Buffer): string => (stdout += data.toString()),
        stderr: (data: Buffer): string => (stderr += data.toString())
      }
    }
  );
  return { exitCode, stdout, stderr };
}

export async function putCacheObject(
  config: S3Config,
  key: string,
  archivePath: string,
  metadata: CacheObjectMetadata
): Promise<void> {
  const chunkSize = config.chunkSize || 10 * 1024 * 1024;
  core.debug(`Uploading cache archive to s3://${config.bucket}/${key}`);

  const result = await execRclone(
    [
      'copyto',
      archivePath,
      remote(config, key),
      '--s3-upload-cutoff',
      '0',
      '--s3-chunk-size',
      String(chunkSize),
      '--s3-upload-concurrency',
      '4',
      // --metadata is required for --metadata-set values to be transmitted to S3
      '--metadata',
      '--metadata-set',
      `cache-key=${metadata.cacheKey}`,
      '--metadata-set',
      `cache-version=${metadata.cacheVersion}`,
      '--metadata-set',
      `cache-platform=${metadata.platform}`,
      '--metadata-set',
      `cache-size=${metadata.size}`,
      '--quiet'
    ],
    config
  );

  if (result.exitCode !== 0) {
    throw new Error(`rclone copyto failed (${result.exitCode}): ${result.stderr}`);
  }
  core.debug(`Cache archive uploaded successfully: ${key}`);
}

export async function statCacheObject(
  config: S3Config,
  key: string
): Promise<CacheObject | null> {
  // rclone removed the `stat` command (>= 1.66); lsjson on the exact object
  // path returns a single-element array for an existing object and an empty
  // array for a missing object (exit code 0 in both cases when the bucket
  // exists). Any other non-zero exit (e.g. missing bucket) is an error.
  const result = await execRclone(
    ['lsjson', remote(config, key), '--files-only', '--metadata', '--quiet'],
    config
  );
  if (result.exitCode !== 0) {
    throw new Error(`rclone lsjson failed (${result.exitCode}): ${result.stderr}`);
  }

  const entries: any[] = JSON.parse(result.stdout || '[]');
  if (entries.length === 0) {
    return null;
  }

  const entry = entries[0];
  return {
    key,
    metadata: {
      cacheKey: entry.Metadata?.['cache-key'] || '',
      cacheVersion: entry.Metadata?.['cache-version'] || '',
      platform: entry.Metadata?.['cache-platform'] || '',
      size: parseInt(entry.Metadata?.['cache-size'] || '0', 10) || 0
    },
    size: entry.Size || 0,
    lastModified: new Date(entry.ModTime)
  };
}

export async function downloadCacheObject(
  config: S3Config,
  key: string,
  destPath: string
): Promise<void> {
  const result = await execRclone(['copyto', remote(config, key), destPath, '--quiet'], config);
  if (result.exitCode !== 0) {
    throw new Error(`rclone copyto failed (${result.exitCode}): ${result.stderr}`);
  }
}

export async function listCacheObjects(
  config: S3Config,
  prefix: string
): Promise<CacheObject[]> {
  // rclone lsjson does not support prefix matching on flat object keys: it
  // treats the final path component as a directory name. Objects are stored
  // flat in the bucket (key = cache key), so list the bucket root and filter
  // by prefix here.
  const result = await execRclone(
    ['lsjson', `s3:${config.bucket}`, '--files-only', '--metadata', '--quiet'],
    config
  );
  if (result.exitCode !== 0) {
    throw new Error(`rclone lsjson failed (${result.exitCode}): ${result.stderr}`);
  }

  const entries: any[] = JSON.parse(result.stdout || '[]');
  const objects: CacheObject[] = entries
    .filter(entry => (entry.Path || entry.Name).startsWith(prefix))
    .map(entry => ({
      key: entry.Path || entry.Name,
      metadata: {
        cacheKey: entry.Metadata?.['cache-key'] || '',
        cacheVersion: entry.Metadata?.['cache-version'] || '',
        platform: entry.Metadata?.['cache-platform'] || '',
        size: parseInt(entry.Metadata?.['cache-size'] || '0', 10) || 0
      },
      size: entry.Size || 0,
      lastModified: new Date(entry.ModTime)
    }));

  return objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

export async function deleteCacheObject(
  config: S3Config,
  key: string
): Promise<void> {
  const result = await execRclone(['deletefile', remote(config, key), '--quiet'], config);
  if (result.exitCode !== 0) {
    throw new Error(`rclone deletefile failed (${result.exitCode}): ${result.stderr}`);
  }
}
