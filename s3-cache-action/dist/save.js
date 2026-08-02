"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCache = saveCache;
const core = __importStar(require("@actions/core"));
const fs = __importStar(require("fs"));
const s3_1 = require("./s3");
const cache_1 = require("./cache");
const utils_1 = require("./utils");
const CACHE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB
async function saveCache(primaryKey, paths, enableCrossOsArchive) {
    (0, utils_1.validateKey)(primaryKey);
    (0, utils_1.validatePaths)(paths);
    const config = {
        endpoint: process.env.INPUT_S3_ENDPOINT,
        accessKeyId: process.env.INPUT_S3_ACCESS_KEY,
        secretAccessKey: process.env.INPUT_S3_SECRET_KEY,
        bucket: process.env.INPUT_S3_BUCKET,
        // Defaults to path-style (true); any value other than the exact string 'false' enables it
        forcePathStyle: process.env.INPUT_S3_PATH_STYLE !== 'false',
        chunkSize: parseInt(process.env.INPUT_UPLOAD_CHUNK_SIZE || '10485760', 10)
    };
    if (await (0, s3_1.statCacheObject)(config, primaryKey)) {
        core.info(`Cache already exists with key ${primaryKey}, not saving cache.`);
        return;
    }
    const compressionMethod = await (0, utils_1.getCompressionMethod)();
    const resolvedPaths = await (0, cache_1.resolvePaths)(paths);
    core.debug(`Resolved Cache Paths: ${JSON.stringify(resolvedPaths)}`);
    const cacheVersion = (0, utils_1.getCacheVersion)(resolvedPaths, compressionMethod, enableCrossOsArchive);
    const tempDir = await (0, cache_1.createTempDirectory)();
    let archivePath;
    try {
        archivePath = await (0, cache_1.createTar)(tempDir, resolvedPaths, compressionMethod);
        const archiveFileSize = (0, cache_1.getArchiveFileSizeInBytes)(archivePath);
        core.debug(`File Size: ${archiveFileSize}`);
        if (archiveFileSize > CACHE_SIZE_LIMIT) {
            throw new Error(`Cache size of ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B) is over the 5GB limit, not saving cache.`);
        }
        await (0, s3_1.putCacheObject)(config, primaryKey, archivePath, {
            cacheKey: primaryKey,
            cacheVersion,
            platform: process.platform,
            size: archiveFileSize
        });
    }
    finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    core.info(`Cache saved with key: ${primaryKey}`);
    return primaryKey;
}
//# sourceMappingURL=save.js.map