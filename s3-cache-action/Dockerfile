FROM node:26-slim

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
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit-dev

# Copy compiled JavaScript (produced by tsc during build)
COPY dist/ ./dist/

# Entrypoint scripts
COPY entrypoint.sh ./entrypoint.sh
COPY entrypoint-save.sh ./entrypoint-save.sh
RUN chmod +x ./entrypoint.sh ./entrypoint-save.sh

ENTRYPOINT ["/action/entrypoint.sh"]
