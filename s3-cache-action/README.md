# S3 Cache Action

A GitHub Action that caches dependencies and build outputs in any
S3-compatible object store (MinIO, RustFS, Ceph, AWS S3, ...). It is designed
as a drop-in replacement for `actions/cache`: swap the `uses:` reference,
supply S3 connection parameters, and keep everything else the same.

The action restores the cache when the job starts and saves it when the job
completes using the GitHub Actions lifecycle (`main` for restore, `post` with
`post-if: success()` for save). It runs as a plain Node.js action, so it works
on Linux, macOS and Windows runners.

## Features

- Full restore + save lifecycle in a single Node.js action (no Docker, no rclone)
- Key-based restore with `restore-keys` prefix matching
- 7-Zip (LZMA2) archives, created and extracted with the runner's `7z`
  binary (`7z`/`7zz`/`7za`/`7zr`, including the Windows `C:\Program Files\7-Zip`
  install location)
- Absolute-path archives: runner-home directories (`~/.cargo/registry`,
  `~/.npm`, the pnpm store, ...) can be cached directly
- Best-effort hard/symbolic link preservation (`-snh`/`-snl`): fully supported
  on Windows (NTFS); on Linux 7-Zip stores hard links as copies and skips
  relative symlinks — both self-heal on the next package-manager install
- Streaming multipart uploads/downloads via the AWS SDK
- Outputs: `cache-hit`, `cache-matched-key`, `cache-primary-key`
- Path-style or virtual-hosted-style S3 addressing (`s3-path-style`)
- Works against any S3-compatible endpoint; no GitHub cache API dependency

## Prerequisites

1. An S3-compatible endpoint reachable from the runner.
2. A bucket that already exists.
3. Credentials with `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`,
   `s3:DeleteObject` permissions on the bucket.
4. 7-Zip installed on the runner and on PATH:
   - Windows: `choco install 7zip` (or the standard installer)
   - Linux/macOS: the official 7-Zip package (`7zz`) or `p7zip-full` (`7za`)

## Usage

```yaml
- name: Restore and save S3 cache
  uses: your-org/s3-cache-action@v2
  with:
    key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
    path: |
      ~/.npm
      node_modules
    restore-keys: |
      ${{ runner.os }}-npm-
    s3-endpoint: ${{ secrets.S3_ENDPOINT }}
    s3-access-key: ${{ secrets.S3_ACCESS_KEY }}
    s3-secret-key: ${{ secrets.S3_SECRET_KEY }}
    s3-bucket: my-cache-bucket
```

### Inputs

| Input                  | Required | Default      | Description                                                                 |
| ---------------------- | -------- | ------------ | --------------------------------------------------------------------------- |
| `key`                  | Yes      | —            | The cache key. If a cache with this exact key exists it is restored and the save is skipped. |
| `path`                 | Yes      | —            | Path(s) to cache. Globs supported. Relative paths are anchored at the repository root; absolute paths (including `~`) are used as-is. |
| `restore-keys`         | No       | —            | Ordered fallback keys for prefix matching. |
| `s3-endpoint`          | Yes      | —            | S3-compatible endpoint URL (e.g. `https://s3.example.com`). |
| `s3-access-key`        | Yes      | —            | S3 access key ID. |
| `s3-secret-key`        | Yes      | —            | S3 secret access key. |
| `s3-bucket`            | Yes      | —            | Bucket to store cache archives in (must exist). |
| `s3-region`            | No       | `us-east-1`  | Region sent to the endpoint (required by the AWS SDK; most self-hosted stores ignore it). |
| `s3-path-style`        | No       | `true`       | `true` = path-style addressing (self-hosted stores); `false` = virtual-hosted-style (AWS S3). |
| `upload-chunk-size`    | No       | `10485760`   | Multipart upload chunk size in bytes. Increase for faster uploads of large caches. |
| `enableCrossOsArchive` | No       | `false`      | Allow cross-OS cache restore. |
| `fail-on-cache-miss`   | No       | `false`      | Fail the job when no cache entry is found. |

### Outputs

| Output               | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `cache-hit`          | `true` when an exact key match was restored.                           |
| `cache-matched-key`  | The key of the cache entry that was restored (may differ from `key`).  |
| `cache-primary-key`  | The primary key that was searched.                                     |

## How it works

- **Restore** runs in the foreground (`main`): the primary key is looked up
  with an exact object lookup, then each `restore-key` is matched as a prefix
  against the objects in the bucket (most recent match wins). Only objects
  written by this action version (checked via the `cache-version` metadata)
  are considered. On a match, the archive is streamed to disk and extracted
  with `7z x -spf` into the workspace.
- **Save** runs at job completion (`post`, `post-if: success()`): the
  configured paths are archived with `7z a -spf` (absolute paths preserved)
  and uploaded with a streaming multipart upload, carrying `cache-*` user
  metadata on the object. A failed save never fails the job.

Cache objects are stored in the bucket under the cache key itself, e.g.
`linux-npm-abc123def456`, with metadata headers `cache-version`,
`cache-format`, `cache-platform`, `cache-size`.

## Development

```bash
npm install
npm run build   # bundles the TypeScript sources into dist/ with ncc
npm test        # runs the unit test suite (requires 7-Zip on PATH)
```

The `dist/` output is committed; CI runs the end-to-end test against a MinIO
service container.
