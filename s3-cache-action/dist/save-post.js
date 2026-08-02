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
const core = __importStar(require("@actions/core"));
const save_1 = require("./save");
const utils_1 = require("./utils");
// Post-entrypoint: the GitHub Actions runner invokes this script at the end
// of the job (post-if: success()) to save the cache. Action inputs are
// available as INPUT_* environment variables, matching the main entrypoint.
async function run() {
    try {
        const primaryKey = core.getInput('key', { required: true });
        const paths = (0, utils_1.getInputAsArray)('path');
        const enableCrossOsArchive = (0, utils_1.getInputAsBool)('enableCrossOsArchive');
        core.startGroup('Save cache');
        try {
            await (0, save_1.saveCache)(primaryKey, paths, enableCrossOsArchive);
        }
        finally {
            core.endGroup();
        }
    }
    catch (error) {
        // A failed cache save must not fail the job (matches actions/cache).
        core.info(`[warning]Cache save failed: ${error.message}`);
        process.exit(0);
    }
}
run().catch(err => {
    core.info(`[warning]Cache save failed: ${err.message}`);
    process.exit(0);
});
//# sourceMappingURL=save-post.js.map