# Changelog

## [2.0.1](https://github.com/silvenia/github-actions/compare/v2.0.0...v2.0.1) (2026-08-14)


### Bug Fixes

* align save/restore cache-version and drop paths from it ([b3a73fd](https://github.com/silvenia/github-actions/commit/b3a73fd3bb6134fce252a799235aad2845f09421))
* node24 instead of node26 ([9af4c32](https://github.com/silvenia/github-actions/commit/9af4c3288469fa86c043cf3683e2f07ce65b15f5))

## [2.0.0](https://github.com/silvenia/github-actions/compare/v1.1.0...v2.0.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* v2 drops the rclone-based Docker action. The action now runs as a Node.js action (works on Linux, macOS and Windows runners) using @aws-sdk/client-s3 and the runner's 7-Zip binary. Supports caching runner-home directories via ~ expansion; adds the s3-region input. Archives use the 7z format with a bumped cache-version, so v1 zstd objects are ignored on restore.

### Features

* rewrite s3-cache-action as a Node 26 action with 7-Zip ([fd91b92](https://github.com/silvenia/github-actions/commit/fd91b92c2c3cc479c77bad6fb4acac79bb8772c2))

## [1.1.0](https://github.com/silvenia/github-actions/compare/v1.0.0...v1.1.0) (2026-08-02)


### Features

* add release-please and fix MinIO bucket setup in test workflow ([d33a5c5](https://github.com/silvenia/github-actions/commit/d33a5c53a5faeb28c607748c8c168ad2875f18c3))


### Bug Fixes

* make test workflow deterministic by seeding cache instead of relying on post-step save ([844fff6](https://github.com/silvenia/github-actions/commit/844fff6be270a8d189eaf0537da803aaa96b21df))
* reach MinIO service by hostname and fail fast on S3 connection errors ([7ac9647](https://github.com/silvenia/github-actions/commit/7ac964792efe2ee405101ba92bd59a41de5c20b0))
