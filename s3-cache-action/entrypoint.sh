#!/usr/bin/env bash
set -e

# Ensure the dist directory exists and contains the compiled output
if [ ! -d "/action/dist" ]; then
  echo "::error::Compiled output not found. Did you run 'npm run build'?"
  exit 1
fi

# Execute the main entry point
exec node /action/dist/main.js
