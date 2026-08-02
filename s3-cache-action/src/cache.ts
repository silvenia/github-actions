import * as core from '@actions/core';
import * as crypto from 'crypto';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as glob from '@actions/glob';
import * as io from '@actions/io';
import * as os from 'os';
import * as path from 'path';
import { CompressionMethod, ValidationError, getCacheFileName } from './utils';

export async function resolvePaths(patterns: string[]): Promise<string[]> {
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
  // Anchor relative patterns at GITHUB_WORKSPACE: @actions/glob resolves
  // relative patterns against process.cwd(), which for a Docker container
  // action is the image WORKDIR (/action), not the workspace.
  const anchoredPatterns = patterns.map(pattern =>
    path.isAbsolute(pattern) ? pattern : path.join(workspace, pattern)
  );
  const globber = await glob.create(anchoredPatterns.join('\n'), {
    implicitDescendants: false
  });

  const resolved: string[] = [];
  for await (const file of globber.globGenerator()) {
    const relativeFile = path.relative(workspace, file).replace(/\\/g, '/');
    core.debug(`Matched: ${relativeFile}`);
    resolved.push(relativeFile === '' ? '.' : relativeFile);
  }

  if (resolved.length === 0) {
    throw new ValidationError(
      `Path Validation Error: No file(s) found matching the specified patterns: ${patterns.join(', ')}`
    );
  }

  return resolved;
}

export async function createTar(
  archiveFolder: string,
  sourcePaths: string[],
  compressionMethod: CompressionMethod
): Promise<string> {
  const manifestFilename = 'manifest.txt';
  const cacheFileName = getCacheFileName(compressionMethod);
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();

  fs.writeFileSync(path.join(archiveFolder, manifestFilename), sourcePaths.join('\n'));

  const args: string[] = [];
  if (compressionMethod === CompressionMethod.Gzip) {
    args.push('-z');
  } else {
    args.push('--use-compress-program', 'zstd -T0 --long=30');
  }
  args.push(
    '-cf',
    cacheFileName.replace(/\\/g, '/'),
    '-P',
    '-C',
    workspace.replace(/\\/g, '/'),
    '--files-from',
    manifestFilename
  );

  await exec.exec('tar', args, { cwd: archiveFolder });

  return path.join(archiveFolder, cacheFileName);
}

export async function extractTar(
  archivePath: string,
  compressionMethod: CompressionMethod
): Promise<void> {
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
  await io.mkdirP(workspace);

  const args: string[] = [];
  if (compressionMethod === CompressionMethod.Gzip) {
    args.push('-z');
  } else {
    args.push('--use-compress-program', 'zstd -d --long=30');
  }
  args.push(
    '-xf',
    archivePath.replace(/\\/g, '/'),
    '-P',
    '-C',
    workspace.replace(/\\/g, '/')
  );

  await exec.exec('tar', args);
}

export async function createTempDirectory(): Promise<string> {
  const tempDirectory = process.env['RUNNER_TEMP'] || os.tmpdir();
  const dest = path.join(tempDirectory, crypto.randomUUID());
  await io.mkdirP(dest);
  return dest;
}

export function getArchiveFileSizeInBytes(filePath: string): number {
  return fs.statSync(filePath).size;
}
