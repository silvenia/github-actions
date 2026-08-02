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
exports.restoreCache = restoreCache;
const core = __importStar(require("@actions/core"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const s3_1 = require("./s3");
const cache_1 = require("./cache");
const utils_1 = require("./utils");
async function restoreCache(primaryKey, restoreKeys, paths, enableCrossOsArchive, failOnCacheMiss) {
    (0, utils_1.validateKey)(primaryKey);
    (0, utils_1.validatePaths)(paths);
    const compressionMethod = await (0, utils_1.getCompressionMethod)();
    const cacheVersion = (0, utils_1.getCacheVersion)(paths, compressionMethod, enableCrossOsArchive);
    core.debug(`Compression method: ${compressionMethod}`);
    core.debug(`Cache version: ${cacheVersion}`);
    const config = {
        endpoint: process.env.INPUT_S3_ENDPOINT,
        accessKeyId: process.env.INPUT_S3_ACCESS_KEY,
        secretAccessKey: process.env.INPUT_S3_SECRET_KEY,
        bucket: process.env.INPUT_S3_BUCKET,
        // Defaults to path-style (true); any value other than the exact string 'false' enables it
        forcePathStyle: process.env.INPUT_S3_PATH_STYLE !== 'false'
    };
    const keysToSearch = [primaryKey, ...restoreKeys];
    core.debug(`Keys to search: ${JSON.stringify(keysToSearch)}`);
    let matchedKey;
    for (const key of keysToSearch) {
        const hit = await (0, s3_1.statCacheObject)(config, key);
        if (hit) {
            matchedKey = key;
            break;
        }
        if (key !== primaryKey) {
            const matches = await (0, s3_1.listCacheObjects)(config, key);
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
            throw new Error(`Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${primaryKey}`);
        }
        return undefined;
    }
    const tempDir = await (0, cache_1.createTempDirectory)();
    const archivePath = path.join(tempDir, (0, utils_1.getCacheFileName)(compressionMethod));
    await (0, s3_1.downloadCacheObject)(config, matchedKey, archivePath);
    const archiveFileSize = (0, cache_1.getArchiveFileSizeInBytes)(archivePath);
    core.info(`Cache Size: ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B)`);
    try {
        await (0, cache_1.extractTar)(archivePath, compressionMethod);
    }
    finally {
        try {
            fs.unlinkSync(archivePath);
        }
        catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
    const isExact = (0, utils_1.isExactKeyMatch)(primaryKey, matchedKey);
    core.setOutput('cache-hit', isExact.toString());
    core.setOutput('cache-matched-key', matchedKey);
    core.setOutput('cache-primary-key', primaryKey);
    core.info(`Cache restored from key: ${matchedKey}`);
    return matchedKey;
}
//# sourceMappingURL=restore.js.map