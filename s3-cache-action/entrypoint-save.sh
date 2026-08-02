#!/usr/bin/env bash
set -e

# Post-entrypoint: invoked by the GitHub Actions runner at job completion
# (post-if: success()) to save the cache.
exec node /action/dist/save-post.js
