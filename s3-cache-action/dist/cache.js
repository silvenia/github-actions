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
exports.resolvePaths = resolvePaths;
exports.createTar = createTar;
exports.extractTar = extractTar;
exports.createTempDirectory = createTempDirectory;
exports.getArchiveFileSizeInBytes = getArchiveFileSizeInBytes;
const core = __importStar(require("@actions/core"));
const crypto = __importStar(require("crypto"));
const exec = __importStar(require("@actions/exec"));
const fs = __importStar(require("fs"));
const glob = __importStar(require("@actions/glob"));
const io = __importStar(require("@actions/io"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const utils_1 = require("./utils");
async function resolvePaths(patterns) {
    const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
    // Anchor relative patterns at GITHUB_WORKSPACE: @actions/glob resolves
    // relative patterns against process.cwd(), which for a Docker container
    // action is the image WORKDIR (/action), not the workspace.
    const anchoredPatterns = patterns.map(pattern => path.isAbsolute(pattern) ? pattern : path.join(workspace, pattern));
    const globber = await glob.create(anchoredPatterns.join('\n'), {
        implicitDescendants: false
    });
    const resolved = [];
    for await (const file of globber.globGenerator()) {
        const relativeFile = path.relative(workspace, file).replace(/\\/g, '/');
        core.debug(`Matched: ${relativeFile}`);
        resolved.push(relativeFile === '' ? '.' : relativeFile);
    }
    if (resolved.length === 0) {
        throw new utils_1.ValidationError(`Path Validation Error: No file(s) found matching the specified patterns: ${patterns.join(', ')}`);
    }
    return resolved;
}
async function createTar(archiveFolder, sourcePaths, compressionMethod) {
    const manifestFilename = 'manifest.txt';
    const cacheFileName = (0, utils_1.getCacheFileName)(compressionMethod);
    const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
    fs.writeFileSync(path.join(archiveFolder, manifestFilename), sourcePaths.join('\n'));
    const args = [];
    if (compressionMethod === utils_1.CompressionMethod.Gzip) {
        args.push('-z');
    }
    else {
        args.push('--use-compress-program', 'zstd -T0 --long=30');
    }
    args.push('-cf', cacheFileName.replace(/\\/g, '/'), '-P', '-C', workspace.replace(/\\/g, '/'), '--files-from', manifestFilename);
    await exec.exec('tar', args, { cwd: archiveFolder });
    return path.join(archiveFolder, cacheFileName);
}
async function extractTar(archivePath, compressionMethod) {
    const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
    await io.mkdirP(workspace);
    const args = [];
    if (compressionMethod === utils_1.CompressionMethod.Gzip) {
        args.push('-z');
    }
    else {
        args.push('--use-compress-program', 'zstd -d --long=30');
    }
    args.push('-xf', archivePath.replace(/\\/g, '/'), '-P', '-C', workspace.replace(/\\/g, '/'));
    await exec.exec('tar', args);
}
async function createTempDirectory() {
    const tempDirectory = process.env['RUNNER_TEMP'] || os.tmpdir();
    const dest = path.join(tempDirectory, crypto.randomUUID());
    await io.mkdirP(dest);
    return dest;
}
function getArchiveFileSizeInBytes(filePath) {
    return fs.statSync(filePath).size;
}
//# sourceMappingURL=cache.js.map