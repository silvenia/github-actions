import * as core from '@actions/core';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as glob from '@actions/glob';
import * as io from '@actions/io';
import * as os from 'os';
import * as path from 'path';
import { CACHE_FILE_NAME, ValidationError } from './utils';
import { createArchive, extractArchive } from './archiver';

/** Expand a leading ~ (or ~/) to the current user's home directory. */
export function expandTilde(pattern: string): string {
  if (pattern === '~') {
    return os.homedir();
  }
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    return path.join(os.homedir(), pattern.slice(2));
  }
  return pattern;
}

/**
 * Resolve the configured cache paths to absolute paths.
 *
 * Relative patterns are anchored at GITHUB_WORKSPACE (matching the previous
 * container action behavior); absolute patterns, including ~ expansion, are
 * used as-is so runner-home directories (e.g. ~/.cargo/registry) can be
 * cached.
 */
export async function resolvePaths(patterns: string[]): Promise<string[]> {
  const workspace = process.env['GITHUB_WORKSPACE'] || process.cwd();
  const anchoredPatterns = patterns
    .map(expandTilde)
    .map(pattern =>
      path.isAbsolute(pattern) ? pattern : path.join(workspace, pattern)
    );
  const globber = await glob.create(anchoredPatterns.join('\n'), {
    implicitDescendants: false
  });

  const resolved: string[] = [];
  for await (const file of globber.globGenerator()) {
    core.debug(`Matched: ${file}`);
    resolved.push(file);
  }

  if (resolved.length === 0) {
    throw new ValidationError(
      `Path Validation Error: No file(s) found matching the specified patterns: ${patterns.join(', ')}`
    );
  }

  return resolved;
}

/** Create a 7z archive of the resolved absolute paths. */
export async function createCacheArchive(archiveFolder: string, sourcePaths: string[]): Promise<string> {
  const archivePath = path.join(archiveFolder, CACHE_FILE_NAME);
  await createArchive(archivePath, sourcePaths, process.env['GITHUB_WORKSPACE'] || process.cwd());
  return archivePath;
}

/** Extract a 7z archive, restoring entries to their absolute paths. */
export async function extractCacheArchive(archivePath: string): Promise<void> {
  await extractArchive(archivePath, process.env['GITHUB_WORKSPACE'] || process.cwd());
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
