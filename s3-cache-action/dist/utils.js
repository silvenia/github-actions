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
exports.ValidationError = exports.CompressionMethod = void 0;
exports.isExactKeyMatch = isExactKeyMatch;
exports.getInputAsArray = getInputAsArray;
exports.getInputAsBool = getInputAsBool;
exports.getInputAsInt = getInputAsInt;
exports.logWarning = logWarning;
exports.validateKey = validateKey;
exports.validatePaths = validatePaths;
exports.getCompressionMethod = getCompressionMethod;
exports.getCacheFileName = getCacheFileName;
exports.getCacheVersion = getCacheVersion;
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const crypto = __importStar(require("crypto"));
var CompressionMethod;
(function (CompressionMethod) {
    CompressionMethod["Gzip"] = "gzip";
    CompressionMethod["Zstd"] = "zstd";
    CompressionMethod["ZstdWithoutLong"] = "zstd-without-long";
})(CompressionMethod || (exports.CompressionMethod = CompressionMethod = {}));
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}
exports.ValidationError = ValidationError;
function isExactKeyMatch(key, cacheKey) {
    return !!(cacheKey && cacheKey.localeCompare(key, undefined, { sensitivity: 'accent' }) === 0);
}
function getInputAsArray(name) {
    return core
        .getInput(name)
        .split('\n')
        .map(s => s.replace(/^!\s+/, '!').trim())
        .filter(x => x !== '');
}
function getInputAsBool(name) {
    return core.getInput(name).toLowerCase() === 'true';
}
function getInputAsInt(name) {
    const value = parseInt(core.getInput(name));
    if (isNaN(value) || value < 0) {
        return undefined;
    }
    return value;
}
function logWarning(message) {
    core.info(`[warning]${message}`);
}
function validateKey(key) {
    if (!key) {
        throw new ValidationError('Key is not specified.');
    }
    if (key.length > 512) {
        throw new ValidationError(`${key} cannot be larger than 512 characters.`);
    }
    if (/,/.test(key)) {
        throw new ValidationError(`${key} cannot contain commas.`);
    }
    if (/\/\//.test(key)) {
        throw new ValidationError(`${key} cannot contain consecutive forward slashes.`);
    }
}
function validatePaths(paths) {
    if (!paths || paths.length === 0) {
        throw new ValidationError('At least one directory or file path is required.');
    }
}
async function getCompressionMethod() {
    let versionOutput = '';
    // `input` must be truthy: @actions/exec only calls cp.stdin.end() when
    // options.input is set, otherwise zstd blocks forever reading the open
    // stdin pipe.
    await exec.exec('zstd', ['--quiet'], {
        ignoreReturnCode: true,
        silent: true,
        input: Buffer.from('\n'),
        listeners: {
            stdout: (data) => (versionOutput += data.toString()),
            stderr: (data) => (versionOutput += data.toString())
        }
    });
    return versionOutput.trim() === '' ? CompressionMethod.Gzip : CompressionMethod.ZstdWithoutLong;
}
function getCacheFileName(compressionMethod) {
    return compressionMethod === CompressionMethod.Gzip ? 'cache.tgz' : 'cache.tzst';
}
function getCacheVersion(paths, compressionMethod, enableCrossOsArchive) {
    const versionSalt = '1.0';
    const components = [...paths];
    if (compressionMethod) {
        components.push(compressionMethod);
    }
    if (process.platform === 'win32' && !enableCrossOsArchive) {
        components.push('windows-only');
    }
    components.push(versionSalt);
    return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}
//# sourceMappingURL=utils.js.map