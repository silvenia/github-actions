import * as core from '@actions/core';
import { restoreCache } from './restore';
import { getS3Config } from './s3';
import { getInputAsArray, getInputAsBool } from './utils';

async function run(): Promise<void> {
  try {
    const primaryKey = core.getInput('key', { required: true });
    const paths = getInputAsArray('path');
    const restoreKeys = getInputAsArray('restore-keys');
    const enableCrossOsArchive = getInputAsBool('enableCrossOsArchive');
    const failOnCacheMiss = getInputAsBool('failOnCacheMiss');
    const config = getS3Config();

    core.setOutput('cache-primary-key', primaryKey);

    core.startGroup('Restore cache');
    try {
      await restoreCache(
        primaryKey,
        restoreKeys,
        paths,
        enableCrossOsArchive,
        failOnCacheMiss,
        config
      );
    } finally {
      core.endGroup();
    }
  } catch (error) {
    core.setFailed((error as Error).message);
    process.exit(1);
  }
}

run().catch(err => {
  core.error(err.message);
  process.exit(1);
});
