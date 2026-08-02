# Changelog

## [1.1.0](https://github.com/silvenia/github-actions/compare/v1.0.0...v1.1.0) (2026-08-02)


### Features

* add release-please and fix MinIO bucket setup in test workflow ([d33a5c5](https://github.com/silvenia/github-actions/commit/d33a5c53a5faeb28c607748c8c168ad2875f18c3))


### Bug Fixes

* make test workflow deterministic by seeding cache instead of relying on post-step save ([844fff6](https://github.com/silvenia/github-actions/commit/844fff6be270a8d189eaf0537da803aaa96b21df))
* reach MinIO service by hostname and fail fast on S3 connection errors ([7ac9647](https://github.com/silvenia/github-actions/commit/7ac964792efe2ee405101ba92bd59a41de5c20b0))
