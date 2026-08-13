import * as core from '@actions/core';
import { saveCache } from './save';
import { getS3Config } from './s3';
import { getInputAsArray, getInputAsBool } from './utils';

// Post-entrypoint: the GitHub Actions runner invokes this script at the end
// of the job (post-if: success()) to save the cache.
async function run(): Promise<void> {
  try {
    const primaryKey = core.getInput('key', { required: true });
    const paths = getInputAsArray('path');
    const enableCrossOsArchive = getInputAsBool('enableCrossOsArchive');
    const config = getS3Config();

    core.startGroup('Save cache');
    try {
      await saveCache(primaryKey, paths, enableCrossOsArchive, config);
    } finally {
      core.endGroup();
    }
  } catch (error) {
    // A failed cache save must not fail the job (matches actions/cache).
    core.info(`[warning]Cache save failed: ${(error as Error).message}`);
    process.exit(0);
  }
}

run().catch(err => {
  core.info(`[warning]Cache save failed: ${err.message}`);
  process.exit(0);
});
