import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as io from '@actions/io';
import * as path from 'path';

const SEVEN_ZIP_NAMES = ['7z', '7zz', '7za', '7zr'];

const WINDOWS_SEVEN_ZIP_PATHS = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe'
];

/** Locate the 7-Zip executable on PATH (with a Windows choco fallback). */
export async function find7z(): Promise<string> {
  for (const name of SEVEN_ZIP_NAMES) {
    try {
      const resolved = await io.which(name, true);
      if (resolved) {
        return resolved;
      }
    } catch {
      // not on PATH, try the next candidate
    }
  }
  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_SEVEN_ZIP_PATHS) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error(
    '7-Zip not found on PATH. Install it (e.g. `choco install 7zip` on Windows or the official ' +
      '7-Zip package providing `7zz`/`7z` on Linux) or add it to PATH.'
  );
}

/**
 * Create a .7z archive containing the given absolute paths.
 *
 * `-spf` stores fully qualified paths in the archive so that extraction
 * restores files to their original absolute locations (required for caching
 * runner-home directories such as ~/.cargo/registry).
 */
export async function createArchive(
  archivePath: string,
  sourcePaths: string[],
  cwd: string
): Promise<void> {
  const sevenZip = await find7z();
  const listFile = path.join(path.dirname(archivePath), 'paths.txt');
  fs.writeFileSync(listFile, sourcePaths.join('\n'));

  try {
    const args = [
      'a',
      '-t7z',
      '-mx=3',
      '-mmt=on',
      '-spf',
      '-snh',
      '-snl',
      '-bso0',
      '-bsp0',
      archivePath,
      `@${listFile}`
    ];
    core.debug(`${sevenZip} ${args.join(' ')}`);
    await exec.exec(sevenZip, args, { cwd });
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

/** Extract a .7z archive, restoring entries to their absolute paths. */
export async function extractArchive(archivePath: string, cwd: string): Promise<void> {
  const sevenZip = await find7z();
  const args = ['x', '-y', '-spf', '-bso0', '-bsp0', archivePath];
  core.debug(`${sevenZip} ${args.join(' ')}`);
  await exec.exec(sevenZip, args, { cwd });
}
