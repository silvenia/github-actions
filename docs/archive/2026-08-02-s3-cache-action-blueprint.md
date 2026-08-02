# S3 Cache Action — Implementation Blueprint

## Objective

Build a **Docker Container GitHub Action** that provides full dependency caching backed by any S3-compatible object store (e.g., RustFS, MinIO, Ceph, AWS S3). The action mirrors the behavior of `actions/cache@v4`: it restores cache on invocation and saves cache at job completion, using S3 as the sole storage backend.

**Expected outcome:** A reusable action that developers can drop into any workflow in place of `actions/cache`, with zero changes to workflow syntax other than swapping the `uses:` reference and providing S3 connection parameters.

---

## Current Architecture

The repository `/home/silvest/projects/personal/github-actions` is an **empty umbrella repository** intended to host multiple GitHub Actions. The first action to be implemented is the S3 cache action.

No existing code, configuration, or patterns exist to reference. This blueprint defines the project structure, conventions, and implementation from scratch.

---

## Scope

### In Scope

1. A **Docker Container Action** at `s3-cache-action/`
2. Full restore + save lifecycle (single action invocation)
3. S3-compatible storage layer targeting any S3-compatible object store
4. Key-based cache lookup with restore-keys prefix matching
5. Tar-based compression (zstd preferred, gzip fallback)
6. Outputs: `cache-hit`, `cache-matched-key`, `cache-primary-key`
7. Dockerfile (includes pinned rclone binary), entrypoint script, TypeScript source, tests
8. Cross-OS archive support via `enableCrossOsArchive` input

### Out of Scope

1. GitHub Actions Cache API integration (no `ACTIONS_CACHE_URL` dependency)
2. Azure Blob Storage, Google Cloud Storage, or other backends
3. Cache eviction, retention policies, or cleanup jobs
4. Cache versioning beyond what `actions/cache` uses
5. Pull request merge-ref scoping rules (self-hosted runners do not enforce these)
6. Multi-bucket or per-repo bucket strategies
7. Encryption at rest (handled by the storage backend infrastructure)

---

## Design Decisions

### Decision 1: Standalone S3 Backend (No GitHub Cache API)

**Rationale:** The action must work entirely independently of GitHub's cache service. It stores and retrieves cache archives directly from the configured S3-compatible endpoint. This means key lookup is performed by listing S3 objects and matching prefixes, not by calling GitHub's `_apis/artifactcache` endpoint.

**Alternatives considered:**
- Hybrid approach (GitHub API for metadata + S3 for storage): Rejected because it requires `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_CACHE_URL`, tying the action to GitHub's internal infrastructure and limiting it to GitHub-hosted runners only.
- Custom REST API server: Rejected because it adds operational overhead. S3 is already the storage layer.

### Decision 2: Node.js (TypeScript) Runtime

**Rationale:** The `@actions/*` toolkit ecosystem (`@actions/core`, `@actions/exec`, `@actions/glob`, `@actions/io`) provides battle-tested utilities for GitHub Actions development. Using the same ecosystem as `actions/cache` ensures compatibility with runner environment variables, input/output handling, and state management.

**Alternatives considered:**
- Go: Smaller Docker image, compiled binary. Rejected because the `@actions/*` toolkit is Node.js-only, and the tar handling complexity (cross-platform, compression programs) is already solved by `actions/cache`'s approach.
- Python: Simpler to implement. Rejected because the `@actions/*` toolkit is not available, requiring custom implementations of input parsing, output writing, and exit code handling.

### Decision 3: Single Action with Background Save Lifecycle

**Rationale:** The action restores cache immediately on invocation and saves cache at job completion by spawning a background process that listens for `SIGTERM`. This mirrors `actions/cache`'s behavior where the restore runs in the foreground and the save is deferred until the job ends.

**Alternatives considered:**
- Separate restore and save actions: Rejected because it requires the user to manually orchestrate the save step and handle job-completion detection.
- Save-only mode as a separate invocation: Rejected because the user explicitly requested a single action that handles both restore and save.

### Decision 4: S3 Object Key = Cache Key

**Rationale:** The cache key provided by the user is used directly as the S3 object key. This provides O(1) lookup for exact key matches and enables prefix-based restore-keys matching via S3 `list_objects_v2` with a `Prefix` filter.

**Object key format:** `<cache-key>` (e.g., `linux-npm-abc123def456`)

**Metadata stored on the object:**
- `cache-key`: The cache key
- `cache-version`: The cache version hash (for compatibility checking)
- `cache-platform`: The runner OS platform (for cross-OS archive validation)
- `cache-size`: The uncompressed archive size in bytes

### Decision 5: rclone CLI for S3 Operations

**Rationale:** rclone is a battle-tested command-line tool for transferring data to S3-compatible object stores. The action invokes `rclone` via `@actions/exec` instead of embedding an SDK. This reduces the bespoke transfer code in `src/s3.ts` to thin wrappers around `copyto`, `stat`, `lsjson`, and `deletefile`, and delegates multipart chunking, retries, and streaming to rclone — including streaming downloads to disk instead of buffering archives in memory. rclone is invoked against the anonymous `:s3:` remote with configuration supplied entirely through `RCLONE_CONFIG_S3_*` environment variables, so no config file is ever written to disk.

**Alternatives considered:**
- `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (original design): Rejected after review — it required owning and testing a ~200-line SDK layer, and its `GetObject` implementation buffered entire archives in memory.
- Direct HTTP requests with `@actions/http-client`: Rejected because multipart upload logic is complex and error-prone.
- `minio` Node.js client: Rejected because it is a separate dependency with less active maintenance than the official AWS SDK or rclone.

**Version requirement:** rclone ≥ 1.63 is required for `--metadata-set` (setting custom `x-amz-meta-*` metadata on upload) and `--metadata` on `lsjson`/`stat` (reading metadata back). Debian's packaged rclone is too old, so the Dockerfile downloads a pinned stable binary from `downloads.rclone.org` (pinned to `v1.75.0`, see Dockerfile below).

**Future path:** because rclone supports 40+ backends, the transfer layer could later be extended to Azure Blob Storage, GCS, etc. by swapping the `RCLONE_CONFIG_*` environment variables. This is explicitly out of scope today (see Out of Scope); the `s3-*` input contract stays unchanged.

### Decision 6: Configurable S3 Addressing Style (Path-Style vs Virtual-Hosted-Style)

**Rationale:** Self-hosted S3-compatible services (RustFS, MinIO, Ceph) typically require path-style addressing (`https://endpoint/bucket/key`), while AWS S3 and some cloud providers require virtual-hosted-style addressing (`https://bucket.endpoint/key`). The previous design hardcoded `forcePathStyle: true`, which breaks virtual-hosted-style endpoints. A new `s3-path-style` boolean input (default `'true'`) lets users select the addressing style per workflow without code changes. With rclone, the input maps directly to the S3 backend's `force_path_style` config option (`RCLONE_CONFIG_S3_FORCE_PATH_STYLE`).

**Alternatives considered:**
- Hardcode `forcePathStyle: true` (previous design): Rejected because it prevents using the action against AWS S3 and other virtual-hosted-style-only endpoints.
- Auto-detect the addressing style by probing the endpoint: Rejected because probing adds latency and complexity, can produce false results for misconfigured endpoints, and is unnecessary when the user knows their endpoint type.
- Default `false` (AWS SDK default): Rejected because the primary use case is self-hosted S3-compatible stores; defaulting to `'true'` preserves the original behavior and requires no workflow changes for existing users.

---

## File Changes

### New Directory Structure

```
github-actions/
├── docs/
│   └── s3-cache-action-blueprint.md          # This file
└── s3-cache-action/
    ├── action.yml                                 # GitHub Action manifest
    ├── Dockerfile                                 # Docker image definition
    ├── entrypoint.sh                              # Entrypoint script
    ├── package.json                               # Node.js dependencies
    ├── tsconfig.json                              # TypeScript configuration
    ├── src/
    │   ├── main.ts                                # Entry point — orchestrates lifecycle
    │   ├── restore.ts                             # Restore logic
    │   ├── save.ts                                # Save logic
    │   ├── s3.ts                                  # S3 storage layer
    │   ├── cache.ts                               # Core cache logic
    │   └── utils.ts                               # Utility functions
    └── __tests__/
        ├── utils.test.ts                          # Utility tests
        ├── s3.test.ts                             # S3 layer tests
        ├── cache.test.ts                          # Cache logic tests
        └── restore.test.ts                        # Restore logic tests
```

---

### File: `s3-cache-action/action.yml`

**Purpose:** GitHub Action manifest defining inputs, outputs, runtime, and branding.

```yaml
name: 'S3 Cache'
description: 'Cache dependencies and build outputs using S3-compatible storage'
author: 'Your Organization'

branding:
  icon: 'archive'
  color: 'blue'

inputs:
  key:
    description: 'The explicit key used for saving and restoring the cache. If the cached cache is found and has the same key the cache is restored and the save step is skipped. Required.'
    required: true

  path:
    description: 'The path(s) to cache. Each path can be a directory or file. Glob patterns are supported. Paths are stored relative to the repository root.'
    required: true

  restore-keys:
    description: 'An ordered list of keys to use for restoring the cache if no cache hit occurred for key. Fallback keys are checked in order, and the most recent cache is restored on a prefix match.'
    required: false

  s3-endpoint:
    description: 'The S3-compatible endpoint URL (e.g., https://s3.example.com or http://localhost:9000).'
    required: true

  s3-access-key:
    description: 'The S3 access key ID for authentication.'
    required: true

  s3-secret-key:
    description: 'The S3 secret access key for authentication.'
    required: true

  s3-bucket:
    description: 'The S3 bucket name to store cache archives.'
    required: true

  s3-path-style:
    description: 'When true, use path-style addressing (https://endpoint/bucket/key) for S3 requests. Required for most self-hosted S3-compatible services (MinIO, RustFS, Ceph). Set to false to use virtual-hosted-style addressing (https://bucket.endpoint/key), which is required for AWS S3 and some cloud providers. Default is true.'
    required: false
    default: 'true'

  upload-chunk-size:
    description: 'The size of each chunk to upload, in bytes (passed to rclone as --s3-chunk-size). Default is 10485760 (10 MB). Increase for faster uploads of large caches.'
    required: false
    default: '10485760'

  enableCrossOsArchive:
    description: 'When enabled, allows Windows runners to save or restore caches independent of the operating system the cache was created on. Default is false.'
    required: false
    default: 'false'

  fail-on-cache-miss:
    description: 'When true, the action fails the job if the cache is not found. Default is false.'
    required: false
    default: 'false'

outputs:
  cache-hit:
    description: 'A boolean value to indicate whether an exact match was found for the key.'
  cache-matched-key:
    description: 'The key of the cache that was matched. This is the key that was used to restore the cache, which may be different from the input key if a restore-key matched.'
  cache-primary-key:
    description: 'The primary key that was used to search for the cache.'

runs:
  using: 'docker'
  image: 'Dockerfile'
  env:
    INPUT_KEY: ${{ inputs.key }}
    INPUT_PATH: ${{ inputs.path }}
    INPUT_RESTORE_KEYS: ${{ inputs.restore-keys }}
    INPUT_S3_ENDPOINT: ${{ inputs.s3-endpoint }}
    INPUT_S3_ACCESS_KEY: ${{ inputs.s3-access-key }}
    INPUT_S3_SECRET_KEY: ${{ inputs.s3-secret-key }}
    INPUT_S3_BUCKET: ${{ inputs.s3-bucket }}
    INPUT_S3_PATH_STYLE: ${{ inputs.s3-path-style }}
    INPUT_UPLOAD_CHUNK_SIZE: ${{ inputs.upload-chunk-size }}
    INPUT_ENABLE_CROSS_OS_ARCHIVE: ${{ inputs.enableCrossOsArchive }}
    INPUT_FAIL_ON_CACHE_MISS: ${{ inputs.fail-on-cache-miss }}
```

---

### File: `s3-cache-action/Dockerfile`

**Purpose:** Defines the Docker container image for the action. Based on `node:20-slim` (LTS), installs system dependencies for tar/zstd, downloads a pinned rclone binary, and copies the compiled TypeScript bundle.

```dockerfile
FROM node:20-slim

# Install system dependencies
# - tar: for creating and extracting cache archives
# - zstd: for zstd compression (preferred over gzip)
# - ca-certificates: for HTTPS connections to S3 endpoint
# - curl + unzip: to download and extract the pinned rclone binary (removed after install)
ARG RCLONE_VERSION=v1.75.0
RUN apt-get update && apt-get install -y \
    tar \
    zstd \
    ca-certificates \
    curl \
    unzip \
    && curl -fsSL "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-amd64.zip" -o /tmp/rclone.zip \
    && unzip /tmp/rclone.zip -d /tmp/rclone \
    && cp /tmp/rclone/rclone-*-linux-amd64/rclone /usr/local/bin/rclone \
    && chmod +x /usr/local/bin/rclone \
    && rm -rf /tmp/rclone.zip /tmp/rclone \
    && apt-get purge -y curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /action

# Copy package files and install dependencies
COPY package.json ./
RUN npm ci --ignore-scripts --omit-dev

# Copy compiled JavaScript (produced by tsc during build)
COPY dist/ ./dist/

# Entrypoint script
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["/action/entrypoint.sh"]
```

**Notes:**
- The rclone zip contains a directory named `rclone-<version>-linux-amd64/`; the glob `rclone-*-linux-amd64/rclone` is expanded by `cp` and matches only that directory.
- `RCLONE_VERSION` is an `ARG`, overridable at build time, but the default is pinned to `v1.75.0` for reproducibility. Verify the pinned version is ≥ 1.63 when updating.
- rclone is a statically linked binary; it requires no additional runtime libraries.

---

### File: `s3-cache-action/entrypoint.sh`

**Purpose:** Shell entrypoint that sets up the Node.js environment and invokes the compiled TypeScript bundle.

```bash
#!/usr/bin/env bash
set -e

# Ensure the dist directory exists and contains the compiled output
if [ ! -d "/action/dist" ]; then
  echo "::error::Compiled output not found. Did you run 'npm run build'?"
  exit 1
fi

# Execute the main entry point
exec node /action/dist/main.js
```

---

### File: `s3-cache-action/package.json`

**Purpose:** Node.js project manifest with all dependencies.

```json
{
  "name": "s3-cache-action",
  "version": "1.0.0",
  "description": "GitHub Action for caching with S3-compatible storage",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "lint": "eslint src/",
    "bundle": "ncc build src/main.ts -o dist"
  },
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/exec": "^1.1.1",
    "@actions/glob": "^0.4.0",
    "@actions/io": "^1.1.3",
    "semver": "^7.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/semver": "^7.5.0",
    "@vercel/ncc": "^0.38.0",
    "typescript": "^5.3.3",
    "jest": "^29.7.0",
    "@types/jest": "^29.5.11",
    "ts-jest": "^29.1.1",
    "eslint": "^8.56.0"
  }
}
```

---

### File: `s3-cache-action/tsconfig.json`

**Purpose:** TypeScript compiler configuration.

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

---

### File: `s3-cache-action/src/utils.ts`

**Purpose:** Utility functions shared across restore and save logic. Mirrors `actions/cache`'s `actionUtils.ts`.

#### Exported types

```typescript
export enum CompressionMethod {
  Gzip = 'gzip',
  Zstd = 'zstd',
  ZstdWithoutLong = 'zstd-without-long'
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}
```

#### Functions

**`isExactKeyMatch(key: string, cacheKey: string | undefined): boolean`**

- **Arguments:** `key` — the primary cache key; `cacheKey` — the matched cache key from S3
- **Return:** `boolean` — `true` if the keys match exactly
- **Behavior:** Uses `localeCompare` with `sensitivity: "accent"` for case-insensitive, accent-insensitive comparison. Returns `false` if `cacheKey` is `undefined`.

```typescript
export function isExactKeyMatch(key: string, cacheKey: string | undefined): boolean {
  return !!(cacheKey && cacheKey.localeCompare(key, undefined, { sensitivity: 'accent' }) === 0);
}
```

**`getInputAsArray(name: string): string[]`**

- **Arguments:** `name` — the input name (e.g., `'path'`, `'restore-keys'`)
- **Return:** `string[]` — non-empty trimmed lines from the input
- **Behavior:** Reads the input via `core.getInput()`, splits by newline, trims whitespace, handles exclusion patterns prefixed with `!`, and filters empty strings.

```typescript
export function getInputAsArray(name: string): string[] {
  return core
    .getInput(name)
    .split('\n')
    .map(s => s.replace(/^!\s+/, '!').trim())
    .filter(x => x !== '');
}
```

**`getInputAsBool(name: string): boolean`**

- **Arguments:** `name` — the input name
- **Return:** `boolean` — `true` if the input value is `'true'` (case-insensitive), `false` otherwise

```typescript
export function getInputAsBool(name: string): boolean {
  return core.getInput(name).toLowerCase() === 'true';
}
```

**`getInputAsInt(name: string): number | undefined`**

- **Arguments:** `name` — the input name
- **Return:** `number | undefined` — parsed integer, or `undefined` if NaN or negative

```typescript
export function getInputAsInt(name: string): number | undefined {
  const value = parseInt(core.getInput(name));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}
```

**`logWarning(message: string): void`**

- **Arguments:** `message` — the warning message
- **Return:** `void`
- **Behavior:** Logs the message with the `[warning]` prefix using `core.info()`.

```typescript
export function logWarning(message: string): void {
  core.info(`[warning]${message}`);
}
```

**`validateKey(key: string): void`**

- **Arguments:** `key` — the cache key to validate
- **Return:** `void`
- **Behavior:** Throws `ValidationError` if the key is empty, exceeds 512 characters, contains commas, or contains consecutive forward slashes (`//`). The `//` rule exists because rclone normalizes consecutive slashes in object keys, which would silently break object lookups.

```typescript
export function validateKey(key: string): void {
  if (!key) {
    throw new ValidationError('Key is not specified.');
  }
  if (key.length > 512) {
    throw new ValidationError(`${key} cannot be larger than 512 characters.`);
  }
  if (/,/.test(key)) {
    throw new ValidationError(`${key} cannot contain commas.`);
  }
  if (/\/\//.test(key)) {
    throw new ValidationError(`${key} cannot contain consecutive forward slashes.`);
  }
}
```

**`validatePaths(paths: string[]): void`**

- **Arguments:** `paths` — the list of paths to validate
- **Return:** `void`
- **Behavior:** Throws `ValidationError` if the array is empty.

```typescript
export function validatePaths(paths: string[]): void {
  if (!paths || paths.length === 0) {
    throw new ValidationError('At least one directory or file path is required.');
  }
}
```

**`getCompressionMethod(): Promise<CompressionMethod>`**

- **Arguments:** None
- **Return:** `Promise<CompressionMethod>` — `'zstd-without-long'` if zstd is available, `'gzip'` otherwise
- **Behavior:** Runs `zstd --quiet` via `@actions/exec` with `ignoreReturnCode: true` and `silent: true`. If version output is non-empty, returns `ZstdWithoutLong`; otherwise falls back to `Gzip`.

```typescript
import * as exec from '@actions/exec';

export async function getCompressionMethod(): Promise<CompressionMethod> {
  let versionOutput = '';
  await exec.exec('zstd', ['--quiet'], {
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data: Buffer): string => (versionOutput += data.toString()),
      stderr: (data: Buffer): string => (versionOutput += data.toString())
    }
  });
  return versionOutput.trim() === '' ? CompressionMethod.Gzip : CompressionMethod.ZstdWithoutLong;
}
```

**`getCacheFileName(compressionMethod: CompressionMethod): string`**

- **Arguments:** `compressionMethod` — the compression method
- **Return:** `string` — `'cache.tzst'` for zstd variants, `'cache.tgz'` for gzip

```typescript
export function getCacheFileName(compressionMethod: CompressionMethod): string {
  return compressionMethod === CompressionMethod.Gzip ? 'cache.tgz' : 'cache.tzst';
}
```

**`getCacheVersion(paths: string[], compressionMethod: CompressionMethod | undefined, enableCrossOsArchive: boolean): string`**

- **Arguments:** `paths` — the cached paths; `compressionMethod` — compression used; `enableCrossOsArchive` — cross-OS flag
- **Return:** `string` — SHA-256 hash of the version components
- **Behavior:** Builds components from paths, compression method, `'windows-only'` (if on win32 and cross-OS disabled), and salt `'1.0'`; hashes with SHA-256.

```typescript
import * as crypto from 'crypto';

export function getCacheVersion(
  paths: string[],
  compressionMethod: CompressionMethod | undefined,
  enableCrossOsArchive: boolean
): string {
  const versionSalt = '1.0';
  const components = [...paths];

  if (compressionMethod) {
    components.push(compressionMethod);
  }
  if (process.platform === 'win32' && !enableCrossOsArchive) {
    components.push('windows-only');
  }
  components.push(versionSalt);

  return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}
```

---

### File: `s3-cache-action/src/s3.ts`

**Purpose:** S3 storage layer that handles all interactions with the S3-compatible store by invoking the `rclone` CLI through `@actions/exec`. rclone is configured entirely via `RCLONE_CONFIG_S3_*` environment variables and invoked against the anonymous `:s3:` remote, so no rclone config file is ever written to disk.

#### Exported types

```typescript
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
```

#### Helpers

**`buildRcloneEnv(config: S3Config): Record<string, string>`**

- **Arguments:** `config` — S3 connection configuration
- **Return:** `Record<string, string>` — environment variables for rclone
- **Behavior:** Returns the `RCLONE_CONFIG_S3_*` environment variables that configure the anonymous `:s3:` remote. `forcePathStyle` is serialized as the literal strings `'true'`/`'false'`.

```typescript
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
```

**`remote(config: S3Config, key: string): string`**

- **Arguments:** `config` — S3 connection configuration; `key` — the S3 object key
- **Return:** `string` — the rclone remote path `:s3:<bucket>/<key>`

```typescript
export function remote(config: S3Config, key: string): string {
  return `:s3:${config.bucket}/${key}`;
}
```

**`execRclone(args: string[], config: S3Config): Promise<{ exitCode: number; stdout: string; stderr: string }>`**

- **Arguments:** `args` — rclone CLI arguments; `config` — S3 connection configuration
- **Return:** `Promise<{ exitCode, stdout, stderr }>`
- **Behavior:**
  1. Runs `rclone <args>` via `exec.exec` with `ignoreReturnCode: true`, `silent: true`, and `env: { ...process.env, ...buildRcloneEnv(config) }` (the `@actions/exec` `env` option replaces the environment, so `process.env` must be spread in explicitly)
  2. Captures stdout and stderr via listeners
  3. Logs the full command line at debug level; the command arguments never contain credentials because they travel via environment variables
  4. Resolves with `{ exitCode, stdout, stderr }`; never throws on non-zero exit codes (callers decide how to handle them)

```typescript
import * as exec from '@actions/exec';
import * as core from '@actions/core';

export async function execRclone(
  args: string[],
  config: S3Config
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  core.debug(`rclone ${args.join(' ')}`);
  let stdout = '';
  let stderr = '';
  const exitCode = await exec.exec('rclone', args, {
    ignoreReturnCode: true,
    silent: true,
    env: { ...process.env, ...buildRcloneEnv(config) },
    listeners: {
      stdout: (data: Buffer): string => (stdout += data.toString()),
      stderr: (data: Buffer): string => (stderr += data.toString())
    }
  });
  return { exitCode, stdout, stderr };
}
```

#### Functions

**`putCacheObject(config: S3Config, key: string, archivePath: string, metadata: CacheObjectMetadata): Promise<void>`**

- **Arguments:** `config` — S3 connection configuration; `key` — the S3 object key (the cache key); `archivePath` — local path to the tar archive; `metadata` — metadata to store on the object
- **Return:** `Promise<void>`
- **Behavior:**
  1. Logs upload start at debug level
  2. Runs `rclone copyto <archivePath> <remote> --s3-upload-cutoff 0 --s3-chunk-size <chunkSize> --s3-upload-concurrency 4 --metadata-set cache-key=<...> --metadata-set cache-version=<...> --metadata-set cache-platform=<...> --metadata-set cache-size=<...> --quiet`
  3. `--s3-upload-cutoff 0` forces multipart upload for all file sizes (mirrors the previous design, which always used multipart)
  4. `--metadata-set` writes each value as an `x-amz-meta-*` header on the object
  5. Throws `Error` if `exitCode !== 0`, including `stderr` in the message
  6. Logs completion at debug level

```typescript
import * as core from '@actions/core';

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
```

**`statCacheObject(config: S3Config, key: string): Promise<CacheObject | null>`**

- **Arguments:** `config` — S3 connection configuration; `key` — the S3 object key
- **Return:** `Promise<CacheObject | null>` — object info, or `null` if the object does not exist
- **Behavior:**
  1. Runs `rclone stat <remote> --json --metadata --quiet`
  2. rclone exits with code 3 when the object does not exist; returns `null` when `exitCode === 3` or `stderr` matches `/not found/i`
  3. Parses the JSON output and maps `Size`, `ModTime`, and the `Metadata` map (`cache-key`, `cache-version`, `cache-platform`, `cache-size`) into a `CacheObject`
  4. Throws `Error` on any other non-zero exit code, including `stderr`

```typescript
import * as core from '@actions/core';

export async function statCacheObject(
  config: S3Config,
  key: string
): Promise<CacheObject | null> {
  const result = await execRclone(['stat', remote(config, key), '--json', '--metadata'], config);

  if (result.exitCode === 3 || /not found/i.test(result.stderr)) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new Error(`rclone stat failed (${result.exitCode}): ${result.stderr}`);
  }

  const data = JSON.parse(result.stdout);
  return {
    key,
    metadata: {
      cacheKey: data.Metadata?.['cache-key'] || '',
      cacheVersion: data.Metadata?.['cache-version'] || '',
      platform: data.Metadata?.['cache-platform'] || '',
      size: parseInt(data.Metadata?.['cache-size'] || '0', 10) || 0
    },
    size: data.Size || 0,
    lastModified: new Date(data.ModTime)
  };
}
```

**`downloadCacheObject(config: S3Config, key: string, destPath: string): Promise<void>`**

- **Arguments:** `config` — S3 connection configuration; `key` — the S3 object key; `destPath` — local path to write the archive to
- **Return:** `Promise<void>`
- **Behavior:** Runs `rclone copyto <remote> <destPath> --quiet`, which streams the object directly to disk (no in-memory buffering). Throws `Error` if `exitCode !== 0`, including `stderr`.

```typescript
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
```

**`listCacheObjects(config: S3Config, prefix: string): Promise<CacheObject[]>`**

- **Arguments:** `config` — S3 connection configuration; `prefix` — the prefix to filter objects by
- **Return:** `Promise<CacheObject[]>` — matching cache objects, sorted by `lastModified` descending (most recent first)
- **Behavior:**
  1. Runs `rclone lsjson <remote-of-prefix> --files-only --metadata --quiet`; rclone treats a non-directory final path component as a name prefix filter
  2. Parses the JSON array; for each entry maps `Path` (or `Name`) to the object key, `Size` to size, `ModTime` to `lastModified`, and the `Metadata` map to `CacheObjectMetadata`
  3. Returns objects sorted by `lastModified` descending
  4. Throws `Error` if `exitCode !== 0`, including `stderr`

```typescript
export async function listCacheObjects(
  config: S3Config,
  prefix: string
): Promise<CacheObject[]> {
  const result = await execRclone(
    ['lsjson', remote(config, prefix), '--files-only', '--metadata', '--quiet'],
    config
  );
  if (result.exitCode !== 0) {
    throw new Error(`rclone lsjson failed (${result.exitCode}): ${result.stderr}`);
  }

  const entries: any[] = JSON.parse(result.stdout || '[]');
  const objects: CacheObject[] = entries.map(entry => ({
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
```

**`deleteCacheObject(config: S3Config, key: string): Promise<void>`**

- **Arguments:** `config` — S3 connection configuration; `key` — the S3 object key
- **Return:** `Promise<void>`
- **Behavior:** Runs `rclone deletefile <remote> --quiet`. Throws `Error` if `exitCode !== 0`, including `stderr`.

```typescript
export async function deleteCacheObject(
  config: S3Config,
  key: string
): Promise<void> {
  const result = await execRclone(['deletefile', remote(config, key), '--quiet'], config);
  if (result.exitCode !== 0) {
    throw new Error(`rclone deletefile failed (${result.exitCode}): ${result.stderr}`);
  }
}
```

---

### File: `s3-cache-action/src/cache.ts`

**Purpose:** Core cache logic — tar creation, tar extraction, path resolution, and compression handling. Mirrors `actions/cache`'s `tar.ts` and `cacheUtils.ts`.

#### Functions

**`resolvePaths(patterns: string[]): Promise<string[]>`**

- **Arguments:** `patterns` — glob patterns or paths to resolve
- **Return:** `Promise<string[]>` — resolved file paths relative to `GITHUB_WORKSPACE`
- **Behavior:** Uses `@actions/glob` to expand patterns with `implicitDescendants: false`. Returns paths relative to the workspace root so tar entries are workspace-relative. An empty result throws `ValidationError`.

```typescript
import * as glob from '@actions/glob';
import * as path from 'path';
import * as core from '@actions/core';
import { ValidationError } from './utils';

export async function resolvePaths(patterns: string[]): Promise<string[]> {
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
  const globber = await glob.create(patterns.join('\n'), {
    implicitDescendants: false
  });

  const resolved: string[] = [];
  for await (const file of globber.globGenerator()) {
    const relativeFile = path.relative(workspace, file).replace(/\\/g, '/');
    core.debug(`Matched: ${relativeFile}`);
    resolved.push(relativeFile === '' ? '.' : relativeFile);
  }

  if (resolved.length === 0) {
    throw new ValidationError(
      `Path Validation Error: No file(s) found matching the specified patterns: ${patterns.join(', ')}`
    );
  }

  return resolved;
}
```

**`createTar(archiveFolder: string, sourcePaths: string[], compressionMethod: CompressionMethod): Promise<string>`**

- **Arguments:** `archiveFolder` — temporary directory for the archive; `sourcePaths` — resolved paths to include; `compressionMethod` — compression to use
- **Return:** `Promise<string>` — path to the created archive file
- **Behavior:**
  1. Writes `sourcePaths` to `manifest.txt` in `archiveFolder`
  2. Builds tar args: `--use-compress-program 'zstd -T0 --long=30'` for zstd variants, `-z` for gzip
  3. Runs `tar -cf <name> -P -C <workspace> --files-from manifest.txt` with cwd `archiveFolder`
  4. Returns `path.join(archiveFolder, getCacheFileName(compressionMethod))`

```typescript
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import { CompressionMethod, getCacheFileName } from './utils';

export async function createTar(
  archiveFolder: string,
  sourcePaths: string[],
  compressionMethod: CompressionMethod
): Promise<string> {
  const manifestFilename = 'manifest.txt';
  const cacheFileName = getCacheFileName(compressionMethod);
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();

  fs.writeFileSync(path.join(archiveFolder, manifestFilename), sourcePaths.join('\n'));

  const args: string[] = [];
  if (compressionMethod === CompressionMethod.Gzip) {
    args.push('-z');
  } else {
    args.push('--use-compress-program', 'zstd -T0 --long=30');
  }
  args.push(
    '-cf',
    cacheFileName.replace(/\\/g, '/'),
    '-P',
    '-C',
    workspace.replace(/\\/g, '/'),
    '--files-from',
    manifestFilename
  );

  await exec.exec('tar', args, { cwd: archiveFolder });

  return path.join(archiveFolder, cacheFileName);
}
```

**`extractTar(archivePath: string, compressionMethod: CompressionMethod): Promise<void>`**

- **Arguments:** `archivePath` — path to the archive; `compressionMethod` — compression used
- **Return:** `Promise<void>`
- **Behavior:** Ensures `GITHUB_WORKSPACE` exists, then runs `tar -xf <archive> -P -C <workspace>`, using `--use-compress-program 'zstd -d --long=30'` for zstd variants or `-z` for gzip.

```typescript
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { CompressionMethod } from './utils';

export async function extractTar(
  archivePath: string,
  compressionMethod: CompressionMethod
): Promise<void> {
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
  await io.mkdirP(workspace);

  const args: string[] = [];
  if (compressionMethod === CompressionMethod.Gzip) {
    args.push('-z');
  } else {
    args.push('--use-compress-program', 'zstd -d --long=30');
  }
  args.push(
    '-xf',
    archivePath.replace(/\\/g, '/'),
    '-P',
    '-C',
    workspace.replace(/\\/g, '/')
  );

  await exec.exec('tar', args);
}
```

**`createTempDirectory(): Promise<string>`**

- **Arguments:** None
- **Return:** `Promise<string>` — path to a newly created unique temporary directory
- **Behavior:** Creates a unique directory under `RUNNER_TEMP` (fallback: `os.tmpdir()`) using `crypto.randomUUID()`.

```typescript
import * as crypto from 'crypto';
import * as io from '@actions/io';
import * as os from 'os';
import * as path from 'path';

export async function createTempDirectory(): Promise<string> {
  const tempDirectory = process.env['RUNNER_TEMP'] || os.tmpdir();
  const dest = path.join(tempDirectory, crypto.randomUUID());
  await io.mkdirP(dest);
  return dest;
}
```

**`getArchiveFileSizeInBytes(filePath: string): number`**

- **Arguments:** `filePath` — path to the archive
- **Return:** `number` — file size in bytes

```typescript
import * as fs from 'fs';

export function getArchiveFileSizeInBytes(filePath: string): number {
  return fs.statSync(filePath).size;
}
```

---

### File: `s3-cache-action/src/restore.ts`

**Purpose:** Restore logic — finds the best matching cache entry in S3 and extracts it to the workspace.

#### Functions

**`restoreCache(primaryKey: string, restoreKeys: string[], paths: string[], enableCrossOsArchive: boolean, failOnCacheMiss: boolean): Promise<string | undefined>`**

- **Arguments:**
  - `primaryKey` — the primary cache key
  - `restoreKeys` — fallback keys for prefix matching
  - `paths` — the cached paths (used for version computation)
  - `enableCrossOsArchive` — whether cross-OS archives are allowed
  - `failOnCacheMiss` — whether to fail when no cache is found
- **Return:** `Promise<string | undefined>` — the matched cache key on success, `undefined` on miss
- **Behavior:**
  1. Validates `primaryKey` and `paths`
  2. Detects compression method and computes cache version
  3. Builds `S3Config` from the `INPUT_S3_*` environment variables: endpoint, access key, secret key, bucket, and `forcePathStyle` derived from `INPUT_S3_PATH_STYLE` (defaults to `true` — any value other than the exact string `'false'`)
  4. Searches keys in order `[primaryKey, ...restoreKeys]`:
     - Exact match: `statCacheObject(config, key)` — if found, use it
     - Prefix match (restore keys only): `listCacheObjects(config, key)` — if matches exist, use the most recent
  5. If no match: logs `Cache not found for input keys`, sets `cache-hit: false` and `cache-primary-key`, throws if `failOnCacheMiss`, otherwise returns `undefined`
  6. On match: downloads the archive to a temp file via `downloadCacheObject` (streams to disk), logs size, extracts via `extractTar`, deletes the temp file in a `finally` block
  7. Sets outputs: `cache-hit` (exact match only), `cache-matched-key`, `cache-primary-key`
  8. Logs `Cache restored from key: <key>`

```typescript
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { S3Config, statCacheObject, downloadCacheObject, listCacheObjects } from './s3';
import { extractTar, createTempDirectory, getArchiveFileSizeInBytes } from './cache';
import {
  CompressionMethod,
  getCompressionMethod,
  getCacheFileName,
  getCacheVersion,
  isExactKeyMatch,
  validateKey,
  validatePaths
} from './utils';

export async function restoreCache(
  primaryKey: string,
  restoreKeys: string[],
  paths: string[],
  enableCrossOsArchive: boolean,
  failOnCacheMiss: boolean
): Promise<string | undefined> {
  validateKey(primaryKey);
  validatePaths(paths);

  const compressionMethod: CompressionMethod = await getCompressionMethod();
  const cacheVersion = getCacheVersion(paths, compressionMethod, enableCrossOsArchive);
  core.debug(`Compression method: ${compressionMethod}`);
  core.debug(`Cache version: ${cacheVersion}`);

  const config: S3Config = {
    endpoint: process.env.INPUT_S3_ENDPOINT!,
    accessKeyId: process.env.INPUT_S3_ACCESS_KEY!,
    secretAccessKey: process.env.INPUT_S3_SECRET_KEY!,
    bucket: process.env.INPUT_S3_BUCKET!,
    // Defaults to path-style (true); any value other than the exact string 'false' enables it
    forcePathStyle: process.env.INPUT_S3_PATH_STYLE !== 'false'
  };

  const keysToSearch = [primaryKey, ...restoreKeys];
  core.debug(`Keys to search: ${JSON.stringify(keysToSearch)}`);

  let matchedKey: string | undefined;

  for (const key of keysToSearch) {
    const hit = await statCacheObject(config, key);
    if (hit) {
      matchedKey = key;
      break;
    }
    if (key !== primaryKey) {
      const matches = await listCacheObjects(config, key);
      if (matches.length > 0) {
        matchedKey = matches[0].key;
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
  const archivePath = path.join(tempDir, getCacheFileName(compressionMethod));
  await downloadCacheObject(config, matchedKey, archivePath);

  const archiveFileSize = getArchiveFileSizeInBytes(archivePath);
  core.info(`Cache Size: ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B)`);

  try {
    await extractTar(archivePath, compressionMethod);
  } finally {
    try {
      fs.unlinkSync(archivePath);
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
```

---

### File: `s3-cache-action/src/save.ts`

**Purpose:** Save logic — creates a tar archive of the specified paths and uploads it to S3.

#### Functions

**`saveCache(primaryKey: string, paths: string[], enableCrossOsArchive: boolean): Promise<string | void>`**

- **Arguments:** `primaryKey` — the cache key to save under; `paths` — the paths to cache; `enableCrossOsArchive` — cross-OS flag
- **Return:** `Promise<string | void>` — the S3 object key on success, `void` if save is skipped
- **Behavior:**
  1. Validates `primaryKey` and `paths`
  2. Builds `S3Config` from the `INPUT_S3_*` environment variables, including `chunkSize` from `INPUT_UPLOAD_CHUNK_SIZE` (default `10485760`) and `forcePathStyle` from `INPUT_S3_PATH_STYLE`
  3. No-op (logs info) if an object with the same key already exists in S3 (checked via `statCacheObject`)
  4. Detects compression method; resolves paths to concrete files
  5. Creates the tar archive in a temp directory
  6. Checks the 5 GB size limit; throws if exceeded
  7. Uploads to S3 via `putCacheObject` with metadata (cache key, version, platform, size)
  8. Deletes the temp directory in a `finally` block
  9. Logs `Cache saved with key: <key>`

```typescript
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
```

---

### File: `s3-cache-action/src/main.ts`

**Purpose:** Entry point that orchestrates the restore + save lifecycle. Runs restore immediately, then spawns a background save listener that waits for `SIGTERM` to trigger save at job completion.

#### Functions

**`run(): Promise<void>`**

- **Arguments:** None
- **Return:** `Promise<void>`
- **Behavior:**
  1. Reads inputs: `key`, `path`, `restore-keys`, `enableCrossOsArchive`, `fail-on-cache-miss`
  2. Sets `cache-primary-key` output immediately
  3. Runs `restoreCache(...)` inside `core.startGroup('Restore cache')` / `core.endGroup()`
  4. Calls `scheduleSave(...)`
  5. Catches errors: `core.setFailed(message)` and `process.exit(1)`

**`scheduleSave(primaryKey: string, paths: string[], enableCrossOsArchive: boolean): void`**

- **Arguments:** `primaryKey` — cache key; `paths` — cached paths; `enableCrossOsArchive` — cross-OS flag
- **Return:** `void`
- **Behavior:**
  1. Writes a small save-script to `${RUNNER_TEMP}/s3-cache-save.js`. The script requires the compiled `save.js` module, registers a `SIGTERM` handler that runs `saveCache(...)` and exits `0`, and a `SIGINT` handler that exits without saving.
  2. Spawns `node <script>` with `detached: true`, `stdio: 'ignore'`, and calls `child.unref()` so the parent can exit while the listener stays alive until the job's container teardown.
  3. Logs the child PID at debug level.

```typescript
import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { restoreCache } from './restore';
import { getInputAsArray, getInputAsBool } from './utils';

async function run(): Promise<void> {
  try {
    const primaryKey = core.getInput('key', { required: true });
    const paths = getInputAsArray('path');
    const restoreKeys = getInputAsArray('restore-keys');
    const enableCrossOsArchive = getInputAsBool('enableCrossOsArchive');
    const failOnCacheMiss = getInputAsBool('failOnCacheMiss');

    core.setOutput('cache-primary-key', primaryKey);

    core.startGroup('Restore cache');
    try {
      await restoreCache(primaryKey, restoreKeys, paths, enableCrossOsArchive, failOnCacheMiss);
    } finally {
      core.endGroup();
    }

    scheduleSave(primaryKey, paths, enableCrossOsArchive);
  } catch (error) {
    core.setFailed((error as Error).message);
    process.exit(1);
  }
}

function scheduleSave(
  primaryKey: string,
  paths: string[],
  enableCrossOsArchive: boolean
): void {
  const script = [
    `const core = require('@actions/core');`,
    `const { saveCache } = require('${__dirname}/save');`,
    `process.on('SIGTERM', () => {`,
    `  saveCache(${JSON.stringify(primaryKey)}, ${JSON.stringify(paths)}, ${enableCrossOsArchive})`,
    `    .then(() => process.exit(0))`,
    `    .catch(err => { core.info('[warning]Cache save failed: ' + err.message); process.exit(0); });`,
    `});`,
    `process.on('SIGINT', () => process.exit(0));`,
    ``,
    `setInterval(() => {}, 1000); // keep the process alive`
  ].join('\n');

  const scriptPath = path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 's3-cache-save.js');
  fs.writeFileSync(scriptPath, script);

  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  core.debug(`Save listener spawned with PID ${child.pid}`);
}

run().catch(err => {
  core.error(err.message);
  process.exit(1);
});
```

---

## Data Flow

### Restore Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Runner                            │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  main.ts     │  ──reads inputs──▶  restore.ts               │
│  │              │                                               │
│  │  1. Read     │                                               │
│  │     inputs   │                                               │
│  │  2. Call     │                                               │
│  │     restore  │                                               │
│  │  3. Schedule │                                               │
│  │     save     │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │  restore.ts  │  ──validates──▶  utils.ts                    │
│  │              │                                               │
│  │  1. Validate │                                               │
│  │     key/paths│                                               │
│  │  2. Detect   │                                               │
│  │     compress │                                               │
│  │  3. Compute  │                                               │
│  │     version  │                                               │
│  │  4. Search   │                                               │
│  │     S3 for   │                                               │
│  │     match    │                                               │
│  │  5. Stat +   │                                               │
│  │     download │                                               │
│  │  6. Extract  │                                               │
│  │     to WS    │                                               │
│  │  7. Set      │                                               │
│  │     outputs  │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │    s3.ts     │  ──stat──▶      S3 store                     │
│  │              │  ──lsjson──▶    S3 store                     │
│  │              │  ──copyto──▶    S3 store                     │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Save Flow (triggered by SIGTERM at job end)

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Runner                            │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  Background  │  ◀──SIGTERM──  Job completes                 │
│  │  save.js     │                                               │
│  │  1. Receive  │                                               │
│  │     SIGTERM  │                                               │
│  │  2. Call     │                                               │
│  │     save     │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │    save.ts   │  ──resolvePaths──▶  @actions/glob            │
│  │              │  ──createTar──▶     tar (zstd/gzip)          │
│  │  1. Check    │                                               │
│  │     exists   │                                               │
│  │  2. Resolve  │                                               │
│  │     paths    │                                               │
│  │  3. Create   │                                               │
│  │     tarball  │                                               │
│  │  4. Check    │                                               │
│  │     size     │                                               │
│  │  5. Upload   │                                               │
│  │     to S3    │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │    s3.ts     │  ──copyto (multipart)──▶  S3 store           │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Error Handling

### Expected Failures

| Failure | Handling |
|---------|----------|
| S3 endpoint unreachable | rclone exits non-zero; action fails with the rclone stderr message |
| Invalid S3 credentials | S3 returns 403; rclone exits non-zero; action fails with the rclone stderr message |
| Cache key exceeds 512 chars | `ValidationError`; action fails |
| Cache key contains commas | `ValidationError`; action fails |
| Cache key contains `//` | `ValidationError`; action fails (rclone normalizes consecutive slashes, so such keys are rejected) |
| No paths specified | `ValidationError`; action fails |
| Path patterns match nothing | `ValidationError` on save (`resolvePaths` throws); restore still proceeds |
| Cache not found (miss) | Log info, set `cache-hit: false`, continue (unless `fail-on-cache-miss: true`). `statCacheObject` returns `null` when rclone `stat` exits with code 3 |
| Archive exceeds 5 GB | Throw error; save fails |
| S3 upload fails (5xx / network) | rclone retries (`--low-level-retries` default 10, `--retries` default 3), then exits non-zero; save fails |
| Tar creation fails | Throw error; save fails |
| Tar extraction fails | Throw error; action fails |
| Job fails before completion | Background save process receives `SIGTERM` with job failure; save still runs (matches `actions/cache` post-job behavior) |

### Edge Cases

| Edge Case | Behavior |
|-----------|----------|
| Empty `restore-keys` input | Treated as empty array; only primary key is searched |
| Restore-key with no prefix matches | Continues to next restore key, then reports miss |
| Multiple jobs saving the same key concurrently | Last write wins (S3 has no locking). No locking mechanism. |
| Runner OS differs from cache creation OS | `cache-platform` metadata is stored but not enforced; tar extraction is the effective check. Windows vs. Linux archives differ only in path separators, which tar handles. |
| Cache object exists but is corrupted | Extraction fails; action fails with tar error |
| S3 bucket does not exist | rclone `stat`/`lsjson` exits non-zero; action fails with clear rclone error |
| S3 bucket has no write permissions | S3 returns 403; rclone exits non-zero; action fails with clear rclone error |
| `s3-path-style` set to an unrecognized value | Any value other than the exact string `'false'` is treated as `true` (path-style) |
| rclone binary missing or too old (< 1.63) | `execRclone` throws "rclone not found" (spawn error) or `--metadata-set` is rejected by the CLI; action fails with the exec error |
| Very large cache (>1 GB) | rclone multipart upload handles chunking automatically |
| Uncompressed archive > 5 GB | Save is rejected before upload attempt |

### Retry Strategy

rclone includes built-in retry logic: `--low-level-retries` (default 10) retries individual failed HTTP requests with exponential backoff, and `--retries` (default 3) retries the whole operation. Multipart uploads resume from the last completed part. No custom retry logic is implemented in the action; callers receive the rclone exit code and stderr after retries are exhausted.

---

## API Changes

No API changes. This is a GitHub Action, not a web service.

---

## Database Changes

No database changes. Cache data is stored in the S3-compatible store as object blobs.

---

## Configuration

### Environment Variables (set by action.yml)

| Variable | Source | Required | Description |
|----------|--------|----------|-------------|
| `INPUT_KEY` | `inputs.key` | Yes | Cache key |
| `INPUT_PATH` | `inputs.path` | Yes | Paths to cache |
| `INPUT_RESTORE_KEYS` | `inputs.restore-keys` | No | Fallback keys |
| `INPUT_S3_ENDPOINT` | `inputs.s3-endpoint` | Yes | S3-compatible endpoint URL |
| `INPUT_S3_ACCESS_KEY` | `inputs.s3-access-key` | Yes | S3 access key ID |
| `INPUT_S3_SECRET_KEY` | `inputs.s3-secret-key` | Yes | S3 secret access key |
| `INPUT_S3_BUCKET` | `inputs.s3-bucket` | Yes | S3 bucket name |
| `INPUT_S3_PATH_STYLE` | `inputs.s3-path-style` | No | Path-style addressing flag; any value other than `'false'` selects path-style (default `'true'`) |
| `INPUT_UPLOAD_CHUNK_SIZE` | `inputs.upload-chunk-size` | No | Upload chunk size in bytes; passed to rclone as `--s3-chunk-size` (default 10485760) |
| `INPUT_ENABLE_CROSS_OS_ARCHIVE` | `inputs.enableCrossOsArchive` | No | Cross-OS archive flag (default false) |
| `INPUT_FAIL_ON_CACHE_MISS` | `inputs.fail-on-cache-miss` | No | Fail on miss flag (default false) |

### Internal rclone Environment Variables (set by the action, not by users)

These are generated by `buildRcloneEnv` in `src/s3.ts` and passed to every `rclone` invocation. They configure the anonymous `:s3:` remote; no rclone config file is written.

| Variable | Value | Description |
|----------|-------|-------------|
| `RCLONE_CONFIG_S3_TYPE` | `s3` | rclone backend type |
| `RCLONE_CONFIG_S3_PROVIDER` | `Other` | Generic S3-compatible provider |
| `RCLONE_CONFIG_S3_ENDPOINT` | `INPUT_S3_ENDPOINT` | Endpoint URL |
| `RCLONE_CONFIG_S3_ACCESS_KEY_ID` | `INPUT_S3_ACCESS_KEY` | Access key ID |
| `RCLONE_CONFIG_S3_SECRET_ACCESS_KEY` | `INPUT_S3_SECRET_KEY` | Secret access key |
| `RCLONE_CONFIG_S3_REGION` | `us-east-1` (default) | Region |
| `RCLONE_CONFIG_S3_FORCE_PATH_STYLE` | `'true'` or `'false'` | Derived from `INPUT_S3_PATH_STYLE` |
| `RCLONE_CONFIG_S3_NO_CHECK_BUCKET` | `true` | Skip bucket-existence check on first use |

### Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `enableCrossOsArchive` | `false` | Allow cross-OS cache restoration |
| `failOnCacheMiss` | `false` | Fail the job if cache is not found |
| `s3PathStyle` | `true` | Use path-style S3 addressing; set `false` for virtual-hosted-style (AWS S3) |

### Deployment Requirements

1. The S3-compatible endpoint must be reachable from the GitHub runner (network connectivity)
2. S3 bucket must exist and the access key must have `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject` permissions
3. Runner must have `tar` and preferably `zstd` installed (provided by the Docker image)
4. Runner must have rclone ≥ 1.63 available on `PATH` (provided by the Docker image, pinned to v1.75.0)
5. Runner must have at least 5 GB of free disk space in `RUNNER_TEMP` for archive creation

---

## Security

### Authorization

- S3 credentials are passed as action inputs, which are masked in workflow logs when sourced from GitHub secrets
- The action does not store credentials persistently; they are used only for the lifetime of the container
- The background save process inherits credentials from the parent process environment

### Authentication

- S3 authentication uses AWS Signature V4 signing (handled by rclone)
- Credentials are supplied exclusively through the `RCLONE_CONFIG_S3_ACCESS_KEY_ID` and `RCLONE_CONFIG_S3_SECRET_ACCESS_KEY` environment variables; they never appear in rclone command-line arguments and are never logged
- Credentials are never exposed in workflow output

### Secrets

- `s3-secret-key` is the only secret. It is masked by GitHub Actions when passed as a secret input
- The action does not write secrets to disk
- rclone configuration is supplied entirely via environment variables; no rclone config file (`rclone.conf`) is ever created

### Validation

- Cache keys are validated for length (max 512), comma absence, non-emptiness, and absence of consecutive forward slashes
- Paths are validated for non-emptiness
- S3 endpoint URL is validated as a valid URL by rclone

### Injection Risks

- Cache keys are used as S3 object keys. Keys containing consecutive forward slashes (`//`) are rejected at validation because rclone normalizes them; all other valid key characters are handled safely by rclone.
- rclone commands are built as argument arrays passed to `@actions/exec` — no shell interpolation occurs, so cache keys or paths cannot inject shell commands.
- Path inputs are resolved by `@actions/glob`, which operates within `GITHUB_WORKSPACE`. No path traversal is possible.

### Permission Model

The S3 access key must have the following permissions on the specified bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::BUCKET_NAME",
        "arn:aws:s3:::BUCKET_NAME/*"
      ]
    }
  ]
}
```

---

## Performance

### Algorithmic Complexity

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Exact key match | O(1) | Single `rclone stat` (HEAD) call |
| Prefix match (restore-keys) | O(N), N = objects with matching prefix | `rclone lsjson` with prefix filter; `--metadata` costs one HEAD request per listed object |
| Tar creation | O(F), F = total file size | Linear scan of all files |
| Tar extraction | O(F), F = total archive size | Linear decompression |
| S3 upload | O(F) with parallel multipart chunks | `copyto` with `--s3-upload-concurrency 4` |
| S3 download | O(F) | `copyto` streams directly to disk — no in-memory buffering |

### Caching

The action itself is the caching mechanism; no additional caching layer.

### Expected Bottlenecks

1. **S3 network latency**: Upload/download speed depends on bandwidth between the runner and the S3-compatible endpoint
2. **Tar creation**: Large repositories with many small files take longer to archive
3. **Prefix matching**: Large buckets slow down `lsjson` prefix scans, and `--metadata` adds one HEAD request per matching object

### Scalability

- Scales linearly with cache size
- Multipart upload handles files up to the 5 GB limit
- Concurrent jobs saving the same key result in last-write-wins (no locking)

### Memory Considerations

- Downloads and uploads stream through rclone directly to/from disk — archives are never buffered in Node.js memory.
- rclone multipart uploads use extra memory equal to `--transfers × --s3-upload-concurrency × --s3-chunk-size` (defaults: 4 × 4 × 10 MiB ≈ 160 MiB). This is bounded and unrelated to cache size.
- The Node.js process itself only holds the `lsjson`/`stat` JSON payloads in memory, which are small relative to archive size.

---

## Logging & Monitoring

### New Logs

| Level | Message | Condition |
|-------|---------|-----------|
| `debug` | `Compression method: <method>` | Always |
| `debug` | `Cache version: <version>` | Always |
| `debug` | `rclone <command args>` | On every rclone invocation |
| `debug` | `Uploading cache archive to s3://<bucket>/<key>` | On save |
| `debug` | `Keys to search: [<keys>]` | Always |
| `debug` | `Archive Path: <path>` | On restore |
| `debug` | `Resolved Cache Paths: [<paths>]` | On save |
| `debug` | `File Size: <bytes>` | On save |
| `debug` | `Uploading cache archive (<bytes> bytes) to s3://<bucket>/<key>` | On save |
| `debug` | `Cache archive uploaded successfully: <key>` | On save |
| `info` | `Cache Size: ~<MB> MB (<bytes> B)` | On restore |
| `info` | `Cache restored from key: <key>` | On restore hit |
| `info` | `Cache not found for input keys: [<keys>]` | On restore miss |
| `info` | `Cache already exists with key <key>, not saving cache.` | On save (existing) |
| `info` | `Cache saved with key: <key>` | On save success |
| `warning` | `[warning]Cache save failed: <message>` | On save failure |
| `error` | `<error message>` | On validation/network errors |

### Metrics / Tracing / Dashboards / Alerts

No custom metrics, tracing, dashboards, or alerts are defined. Users should monitor the S3 bucket (size, object count, request latency, error rates) via their own storage backend monitoring tools.

---

## Backwards Compatibility

### Guarantees

- The action is versioned via the `@v1` tag on the repository. Users pin to `@v1` for stability.
- Input names and output names are fixed and will not change between minor versions.
- The S3 object key format (`<cache-key>`) is fixed and will not change.
- The `s3-path-style` input is additive and optional. Omitting it preserves the previous behavior (path-style addressing, `forcePathStyle: true`).
- Key validation now rejects consecutive forward slashes (`//`). This only affects keys that rclone could not reliably access anyway; valid existing keys are unaffected.
- The switch from the AWS SDK to rclone is internal; inputs, outputs, object keys, and metadata header names (`cache-key`, `cache-version`, `cache-platform`, `cache-size`) are unchanged.

### Migration Strategy

- No migration is needed. The action is a drop-in replacement for `actions/cache`.
- Existing caches stored by `actions/cache` are not compatible (different storage backend).
- Users must re-populate the cache on first use.

---

## Testing

### Unit Tests

**File: `__tests__/utils.test.ts`**

| Test | Input | Expected Output |
|------|-------|-----------------|
| `isExactKeyMatch` exact match | `('key1', 'key1')` | `true` |
| `isExactKeyMatch` case insensitive | `('Key1', 'key1')` | `true` |
| `isExactKeyMatch` no match | `('key1', 'key2')` | `false` |
| `isExactKeyMatch` undefined cacheKey | `('key1', undefined)` | `false` |
| `validateKey` empty key | `('')` | Throws `ValidationError` |
| `validateKey` too long | `('a'.repeat(513))` | Throws `ValidationError` |
| `validateKey` comma | `('key,1')` | Throws `ValidationError` |
| `validateKey` consecutive slashes | `('a//b')` | Throws `ValidationError` |
| `validateKey` valid | `('valid-key-123')` | No throw |
| `validatePaths` empty array | `([])` | Throws `ValidationError` |
| `validatePaths` valid | `(['p1','p2'])` | No throw |
| `getInputAsArray` single line | `'p1'` | `['p1']` |
| `getInputAsArray` multi line | `'p1\np2\np3'` | `['p1','p2','p3']` |
| `getInputAsArray` empty lines | `'p1\n\np2'` | `['p1','p2']` |
| `getInputAsBool` true | `'true'` | `true` |
| `getInputAsBool` false | `'false'` | `false` |
| `getInputAsBool` uppercase | `'TRUE'` | `true` |
| `getInputAsInt` valid | `'10485760'` | `10485760` |
| `getInputAsInt` invalid | `'abc'` | `undefined` |
| `getInputAsInt` negative | `'-1'` | `undefined` |
| `getCacheVersion` deterministic | `(['p1'], 'gzip', false)` | Stable hash |
| `getCacheVersion` differs by compression | gzip vs zstd | Different hashes |
| `getCacheFileName` gzip | `Gzip` | `'cache.tgz'` |
| `getCacheFileName` zstd | `Zstd` | `'cache.tzst'` |

**File: `__tests__/s3.test.ts`** (mock `@actions/exec` `exec.exec`; assert the constructed rclone argument arrays and behavior on mocked `{ exitCode, stdout, stderr }`)

| Test | Expected Output |
|------|-----------------|
| `buildRcloneEnv` with `forcePathStyle: true` | Includes `RCLONE_CONFIG_S3_TYPE: 's3'`, endpoint, credentials, region, `RCLONE_CONFIG_S3_FORCE_PATH_STYLE: 'true'`, `RCLONE_CONFIG_S3_NO_CHECK_BUCKET: 'true'` |
| `buildRcloneEnv` with `forcePathStyle: false` | `RCLONE_CONFIG_S3_FORCE_PATH_STYLE: 'false'` |
| `remote` | `:s3:bucket/key` |
| `execRclone` merges env | `exec.exec` called with `env` containing `process.env` plus `buildRcloneEnv(config)` |
| `execRclone` captures output | Resolves `{ exitCode, stdout, stderr }` from listeners |
| `putCacheObject` builds upload args | `execRclone` called with `copyto`, archive path, remote, `--s3-upload-cutoff 0`, `--s3-chunk-size`, `--s3-upload-concurrency 4`, four `--metadata-set` flags, `--quiet` |
| `putCacheObject` non-zero exit | Throws with stderr in message |
| `statCacheObject` hit | Parsed `CacheObject` with metadata, size, lastModified |
| `statCacheObject` missing (exit code 3) | `null` returned |
| `statCacheObject` other non-zero exit | Throws with stderr in message |
| `downloadCacheObject` success | `copyto <remote> <destPath>` invoked |
| `listCacheObjects` sorts by ModTime desc | Sorted array (most recent first) |
| `listCacheObjects` maps metadata | `cache-key`/`cache-version`/`cache-platform`/`cache-size` extracted from `Metadata` |
| `listCacheObjects` non-zero exit | Throws with stderr in message |
| `deleteCacheObject` deletes | `deletefile <remote>` invoked |

**File: `__tests__/cache.test.ts`**

| Test | Expected Output |
|------|-----------------|
| `createTar` gzip | `cache.tgz` created, contains paths |
| `createTar` zstd | `cache.tzst` created, contains paths |
| `extractTar` gzip round-trip | Files extracted to workspace |
| `extractTar` zstd round-trip | Files extracted to workspace |
| `resolvePaths` single file | `['package.json']` |
| `resolvePaths` glob | All matched files |
| `resolvePaths` no matches | Throws `ValidationError` |
| `createTempDirectory` | New unique dir exists |

**File: `__tests__/restore.test.ts`** (mock `s3.ts` functions)

| Test | Expected Output |
|------|-----------------|
| Exact key hit | `cache-hit: true`, matched key returned, archive extracted |
| Prefix restore-key hit | `cache-hit: false`, matched key returned |
| Miss without failOnCacheMiss | `undefined`, `cache-hit: false` |
| Miss with failOnCacheMiss | Throws with `fail-on-cache-miss` message |

### Integration Tests

1. **End-to-end restore and save cycle**: first run → `cache-hit: false`; second run → `cache-hit: true`; S3 bucket contains the object with correct metadata.
2. **Restore-keys prefix matching**: save `linux-npm-abc123`, restore with key `linux-npm-def456` and restore-key `linux-npm-` → cache restored, `cache-hit: false`, `cache-matched-key: linux-npm-abc123`.
3. **Fail on cache miss**: non-existent key with `fail-on-cache-miss: true` → action fails.
4. **Large cache upload**: 2 GB test file → upload completes, download matches original.
5. **Concurrent jobs**: two jobs saving the same key → both succeed, last write wins.

### Manual Verification Checklist

- [ ] Action runs successfully on a GitHub-hosted runner against a real S3-compatible endpoint
- [ ] First run (cache miss) completes, sets `cache-hit: false`
- [ ] Second run (cache hit) restores files, sets `cache-hit: true`
- [ ] Restore-keys prefix matching works
- [ ] S3 bucket contains the cache object with correct `x-amz-meta-cache-*` metadata headers (verify with `rclone lsjson --metadata` or the S3 console)
- [ ] `rclone version` in the container reports ≥ 1.63
- [ ] Large cache (>1 GB) uploads and downloads successfully
- [ ] `fail-on-cache-miss: true` fails the action on miss
- [ ] Invalid S3 credentials produce a clear error message
- [ ] `s3-path-style: 'false'` works against an AWS S3 endpoint (virtual-hosted-style addressing)
- [ ] Unreachable S3 endpoint produces a clear error message
- [ ] Cache key validation rejects keys > 512 chars, keys with commas, and keys with `//`
- [ ] Background save completes at job end (verify object exists in bucket after job)

---

## Rollback Plan

### How to Safely Revert

1. **Revert the action code**:
   ```bash
   git revert <commit-hash>
   git push
   ```
2. **Re-tag the Docker image**: create a new tag pointing at the previous commit, or pin workflows to a commit SHA instead of a tag.
3. **Revert workflow changes**: update `uses:` references back to the previous version.

### Data Rollback

- Cache data in S3 is not affected by reverting the action.
- Existing cache objects remain in S3 and can be used by previous versions of the action.
- To clean up cache data, manually delete objects from the S3 bucket.

---

## Acceptance Criteria

- [ ] The action is a valid Docker Container Action (passes `action-validator`)
- [ ] The `action.yml` defines all required inputs, outputs, and runtime configuration
- [ ] The Dockerfile builds successfully and produces a working container with rclone v1.75.0 installed
- [ ] The action restores cache on invocation (cache hit and cache miss scenarios)
- [ ] The action saves cache at job completion (via background SIGTERM listener)
- [ ] Restore-keys prefix matching works correctly
- [ ] The `cache-hit`, `cache-matched-key`, and `cache-primary-key` outputs are set correctly
- [ ] S3 objects are stored with correct `x-amz-meta-cache-*` metadata headers
- [ ] Large caches (>1 GB) upload and download successfully via rclone multipart upload
- [ ] `fail-on-cache-miss` flag causes the action to fail on miss
- [ ] Cache key validation rejects invalid keys (empty, > 512 chars, commas, `//`)
- [ ] Path validation rejects empty path lists
- [ ] Error messages are clear and actionable (rclone stderr is surfaced)
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] The action works with a real S3-compatible endpoint (e.g., RustFS)
- [ ] The `s3-path-style` input controls S3 addressing: `'true'` (default) uses path-style, `'false'` uses virtual-hosted-style

---

## Implementation Checklist

Complete these items in order. Do not skip items.

### Phase 1: Project Setup

- [ ] Create directory structure: `s3-cache-action/` with all subdirectories
- [ ] Create `action.yml` with all inputs, outputs, and runtime configuration, including the `s3-path-style` input (default `'true'`)
- [ ] Create `Dockerfile` based on `node:20-slim` with tar, zstd, and the pinned rclone v1.75.0 binary installed
- [ ] Create `entrypoint.sh` that invokes the compiled Node.js bundle
- [ ] Create `package.json` with all dependencies
- [ ] Create `tsconfig.json` with strict TypeScript configuration
- [ ] Run `npm install` to verify dependencies resolve
- [ ] Run `npm run build` to verify TypeScript compiles (empty src for now)

### Phase 2: Utility Layer

- [ ] Implement `src/utils.ts`: `isExactKeyMatch`, `getInputAsArray`, `getInputAsBool`, `getInputAsInt`, `logWarning`, `validateKey`, `validatePaths`, `getCompressionMethod`, `getCacheFileName`, `getCacheVersion`, `ValidationError`
- [ ] Write unit tests in `__tests__/utils.test.ts`
- [ ] Run `npm test` — all pass

### Phase 3: S3 Storage Layer

- [ ] Implement `src/s3.ts`: `buildRcloneEnv`, `remote`, `execRclone`, `putCacheObject` (with `--metadata-set`), `statCacheObject`, `downloadCacheObject`, `listCacheObjects`, `deleteCacheObject`
- [ ] Write unit tests in `__tests__/s3.test.ts` (mock `@actions/exec`)
- [ ] Run `npm test` — all pass

### Phase 4: Cache Logic

- [ ] Implement `src/cache.ts`: `resolvePaths`, `createTar`, `extractTar`, `createTempDirectory`, `getArchiveFileSizeInBytes`
- [ ] Write unit tests in `__tests__/cache.test.ts`
- [ ] Run `npm test` — all pass

### Phase 5: Restore Logic

- [ ] Implement `src/restore.ts`: input validation, compression detection, version computation, `S3Config` construction (reads `INPUT_S3_*` env vars), exact match search via `statCacheObject`, prefix match search via `listCacheObjects`, archive download via `downloadCacheObject` + extraction, output setting, fail-on-cache-miss handling
- [ ] Write unit tests in `__tests__/restore.test.ts`
- [ ] Run `npm test` — all pass

### Phase 6: Save Logic

- [ ] Implement `src/save.ts`: input validation, existing-cache check via `statCacheObject`, path resolution, tar creation, size limit check, S3 upload with metadata via `putCacheObject` (config built from `INPUT_S3_*` env vars), temp cleanup
- [ ] Write unit tests for save scenarios (extend `__tests__/restore.test.ts` or add `__tests__/save.test.ts`)
- [ ] Run `npm test` — all pass

### Phase 7: Lifecycle Orchestration

- [ ] Implement `src/main.ts`: input reading, restore invocation, background save process spawning (SIGTERM listener), error handling and exit codes
- [ ] Run `npm test` — all pass

### Phase 8: Docker Build and Publish

- [ ] Build Docker image: `docker build -t s3-cache-action:latest .`
- [ ] Verify `docker run --rm s3-cache-action:latest rclone version` reports ≥ 1.63
- [ ] Test the Docker image locally with a mock S3 endpoint (e.g., MinIO): verify save uploads with `x-amz-meta-cache-*` headers and restore downloads them
- [ ] Publish Docker image to registry (Docker Hub or ghcr.io)
- [ ] Tag the image with `v1` and a commit SHA

### Phase 9: End-to-End Verification

- [ ] Create a test workflow that uses the action
- [ ] Run the workflow on a GitHub runner with a real S3-compatible endpoint
- [ ] Verify cache miss scenario (first run)
- [ ] Verify cache hit scenario (second run)
- [ ] Verify restore-keys prefix matching
- [ ] Verify large cache upload/download
- [ ] Verify `s3-path-style: 'false'` against AWS S3
- [ ] Verify fail-on-cache-miss behavior
- [ ] Verify error handling (invalid credentials, unreachable endpoint)

### Phase 10: Documentation and Release

- [ ] Add `README.md` to `s3-cache-action/` with usage examples
- [ ] Create a GitHub release tag
- [ ] Update this blueprint with any lessons learned during implementation
- [ ] Archive this blueprint as `docs/s3-cache-action-blueprint.md`
