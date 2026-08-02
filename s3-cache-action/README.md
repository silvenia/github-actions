# S3 Cache Action

A GitHub Action that caches dependencies and build outputs in any
S3-compatible object store (MinIO, RustFS, Ceph, AWS S3, ...). It is designed
as a drop-in replacement for `actions/cache`: swap the `uses:` reference,
supply S3 connection parameters, and keep everything else the same.

The action restores the cache when the job starts and saves it when the job
completes using the GitHub Actions lifecycle (`entrypoint` for restore,
`post-entrypoint` with `post-if: success()` for save).

## Features

- Full restore + save lifecycle in a single Docker container action
- Key-based restore with `restore-keys` prefix matching
- zstd compression (gzip fallback), streaming multipart uploads/downloads via
  rclone (pinned v1.75.0)
- Outputs: `cache-hit`, `cache-matched-key`, `cache-primary-key`
- Path-style or virtual-hosted-style S3 addressing (`s3-path-style`)
- Works against any S3-compatible endpoint; no GitHub cache API dependency

## Prerequisites

1. An S3-compatible endpoint reachable from the runner.
2. A bucket that already exists.
3. Credentials with `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`,
   `s3:DeleteObject` permissions on the bucket.

## Usage

```yaml
- name: Restore and save S3 cache
  uses: your-org/s3-cache-action@v1
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
| `path`                 | Yes      | —            | Path(s) to cache. Globs supported. Paths are relative to the repository root. |
| `restore-keys`         | No       | —            | Ordered fallback keys for prefix matching. |
| `s3-endpoint`          | Yes      | —            | S3-compatible endpoint URL (e.g. `https://s3.example.com`). |
| `s3-access-key`        | Yes      | —            | S3 access key ID. |
| `s3-secret-key`        | Yes      | —            | S3 secret access key. |
| `s3-bucket`            | Yes      | —            | Bucket to store cache archives in (must exist). |
| `s3-path-style`        | No       | `true`       | `true` = path-style addressing (self-hosted stores); `false` = virtual-hosted-style (AWS S3). |
| `upload-chunk-size`    | No       | `10485760`   | Multipart upload chunk size in bytes (passed as `--s3-chunk-size`). |
| `enableCrossOsArchive` | No       | `false`      | Allow cross-OS cache restore. |
| `fail-on-cache-miss`   | No       | `false`      | Fail the job when no cache entry is found. |

### Outputs

| Output               | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `cache-hit`          | `true` when an exact key match was restored.                           |
| `cache-matched-key`  | The key of the cache entry that was restored (may differ from `key`).  |
| `cache-primary-key`  | The primary key that was searched.                                     |

## How it works

- **Restore** runs in the foreground (`entrypoint`): the primary key is looked
  up with an exact object lookup, then each `restore-key` is matched as a
  prefix against the objects in the bucket (most recent match wins). On a
  match, the archive is streamed to disk and extracted into the workspace.
- **Save** runs at job completion (`post-entrypoint`, `post-if: success()`):
  the configured paths are archived with tar + zstd and uploaded with rclone
  as a multipart upload, carrying `cache-*` user metadata on the object.

Cache objects are stored in the bucket under the cache key itself, e.g.
`linux-npm-abc123def456`, with metadata headers
`cache-key`, `cache-version`, `cache-platform`, `cache-size`.

## Development

```bash
npm install
npm run build   # compiles TypeScript into dist/
npm test        # runs the unit test suite
docker build -t s3-cache-action:latest .  # build the container image
```
