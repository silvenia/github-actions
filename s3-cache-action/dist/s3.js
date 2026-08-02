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
exports.buildRcloneEnv = buildRcloneEnv;
exports.remote = remote;
exports.execRclone = execRclone;
exports.putCacheObject = putCacheObject;
exports.statCacheObject = statCacheObject;
exports.downloadCacheObject = downloadCacheObject;
exports.listCacheObjects = listCacheObjects;
exports.deleteCacheObject = deleteCacheObject;
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
function buildRcloneEnv(config) {
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
function remote(config, key) {
    // Reference the "s3" remote by NAME (not the anonymous `:s3:` backend-type
    // syntax): the `:s3:` form ignores the RCLONE_CONFIG_S3_* environment
    // variables, which would make every operation anonymous.
    return `s3:${config.bucket}/${key}`;
}
async function execRclone(args, config) {
    core.debug(`rclone ${args.join(' ')}`);
    let stdout = '';
    let stderr = '';
    const exitCode = await exec.exec('rclone', [
        // Fail fast on unreachable endpoints: the AWS SDK backoff inside rclone
        // retries connection errors for minutes on end by default.
        '--retries',
        '2',
        '--low-level-retries',
        '2',
        ...args
    ], {
        ignoreReturnCode: true,
        silent: true,
        env: { ...process.env, ...buildRcloneEnv(config) },
        listeners: {
            stdout: (data) => (stdout += data.toString()),
            stderr: (data) => (stderr += data.toString())
        }
    });
    return { exitCode, stdout, stderr };
}
async function putCacheObject(config, key, archivePath, metadata) {
    const chunkSize = config.chunkSize || 10 * 1024 * 1024;
    core.debug(`Uploading cache archive to s3://${config.bucket}/${key}`);
    const result = await execRclone([
        'copyto',
        archivePath,
        remote(config, key),
        '--s3-upload-cutoff',
        '0',
        '--s3-chunk-size',
        String(chunkSize),
        '--s3-upload-concurrency',
        '4',
        // --metadata is required for --metadata-set values to be transmitted to S3
        '--metadata',
        '--metadata-set',
        `cache-key=${metadata.cacheKey}`,
        '--metadata-set',
        `cache-version=${metadata.cacheVersion}`,
        '--metadata-set',
        `cache-platform=${metadata.platform}`,
        '--metadata-set',
        `cache-size=${metadata.size}`,
        '--quiet'
    ], config);
    if (result.exitCode !== 0) {
        throw new Error(`rclone copyto failed (${result.exitCode}): ${result.stderr}`);
    }
    core.debug(`Cache archive uploaded successfully: ${key}`);
}
async function statCacheObject(config, key) {
    // rclone removed the `stat` command (>= 1.66); lsjson on the exact object
    // path returns a single-element array for an existing object and an empty
    // array for a missing object (exit code 0 in both cases when the bucket
    // exists). Any other non-zero exit (e.g. missing bucket) is an error.
    const result = await execRclone(['lsjson', remote(config, key), '--files-only', '--metadata', '--quiet'], config);
    if (result.exitCode !== 0) {
        throw new Error(`rclone lsjson failed (${result.exitCode}): ${result.stderr}`);
    }
    const entries = JSON.parse(result.stdout || '[]');
    if (entries.length === 0) {
        return null;
    }
    const entry = entries[0];
    return {
        key,
        metadata: {
            cacheKey: entry.Metadata?.['cache-key'] || '',
            cacheVersion: entry.Metadata?.['cache-version'] || '',
            platform: entry.Metadata?.['cache-platform'] || '',
            size: parseInt(entry.Metadata?.['cache-size'] || '0', 10) || 0
        },
        size: entry.Size || 0,
        lastModified: new Date(entry.ModTime)
    };
}
async function downloadCacheObject(config, key, destPath) {
    const result = await execRclone(['copyto', remote(config, key), destPath, '--quiet'], config);
    if (result.exitCode !== 0) {
        throw new Error(`rclone copyto failed (${result.exitCode}): ${result.stderr}`);
    }
}
async function listCacheObjects(config, prefix) {
    // rclone lsjson does not support prefix matching on flat object keys: it
    // treats the final path component as a directory name. Objects are stored
    // flat in the bucket (key = cache key), so list the bucket root and filter
    // by prefix here.
    const result = await execRclone(['lsjson', `s3:${config.bucket}`, '--files-only', '--metadata', '--quiet'], config);
    if (result.exitCode !== 0) {
        throw new Error(`rclone lsjson failed (${result.exitCode}): ${result.stderr}`);
    }
    const entries = JSON.parse(result.stdout || '[]');
    const objects = entries
        .filter(entry => (entry.Path || entry.Name).startsWith(prefix))
        .map(entry => ({
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
async function deleteCacheObject(config, key) {
    const result = await execRclone(['deletefile', remote(config, key), '--quiet'], config);
    if (result.exitCode !== 0) {
        throw new Error(`rclone deletefile failed (${result.exitCode}): ${result.stderr}`);
    }
}
//# sourceMappingURL=s3.js.map