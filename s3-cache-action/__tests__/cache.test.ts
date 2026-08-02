import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompressionMethod, ValidationError } from '../src/utils';
import { createTar, createTempDirectory, extractTar, resolvePaths } from '../src/cache';

let workspace: string;
let archiveFolder: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-ws-'));
  archiveFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-archive-'));
  process.env['GITHUB_WORKSPACE'] = workspace;
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(archiveFolder, { recursive: true, force: true });
  delete process.env['GITHUB_WORKSPACE'];
});

describe('createTar', () => {
  it('creates a cache.tgz with gzip containing the paths', async () => {
    fs.writeFileSync(path.join(workspace, 'file1.txt'), 'hello');
    const archivePath = await createTar(archiveFolder, ['file1.txt'], CompressionMethod.Gzip);

    expect(fs.existsSync(archivePath)).toBe(true);
    expect(path.basename(archivePath)).toBe('cache.tgz');
    const listing = execSync(`tar -tf "${archivePath}"`).toString();
    expect(listing).toContain('file1.txt');
  });

  it('creates a cache.tzst with zstd containing the paths', async () => {
    fs.writeFileSync(path.join(workspace, 'file1.txt'), 'hello');
    const archivePath = await createTar(archiveFolder, ['file1.txt'], CompressionMethod.Zstd);

    expect(fs.existsSync(archivePath)).toBe(true);
    expect(path.basename(archivePath)).toBe('cache.tzst');
    const listing = execSync(`tar -tf "${archivePath}" --use-compress-program 'zstd -d --long=30'`).toString();
    expect(listing).toContain('file1.txt');
  });
});

describe('extractTar', () => {
  it('round-trips a gzip archive back into the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'file1.txt'), 'hello world');
    const archivePath = await createTar(archiveFolder, ['file1.txt'], CompressionMethod.Gzip);
    fs.rmSync(path.join(workspace, 'file1.txt'));

    await extractTar(archivePath, CompressionMethod.Gzip);

    expect(fs.readFileSync(path.join(workspace, 'file1.txt'), 'utf8')).toBe('hello world');
  });

  it('round-trips a zstd archive back into the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'file1.txt'), 'hello world');
    const archivePath = await createTar(archiveFolder, ['file1.txt'], CompressionMethod.Zstd);
    fs.rmSync(path.join(workspace, 'file1.txt'));

    await extractTar(archivePath, CompressionMethod.Zstd);

    expect(fs.readFileSync(path.join(workspace, 'file1.txt'), 'utf8')).toBe('hello world');
  });
});

describe('resolvePaths', () => {
  it('resolves a single file relative to the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
    const resolved = await resolvePaths([path.join(workspace, 'package.json')]);
    expect(resolved).toEqual(['package.json']);
  });

  it('resolves glob patterns to all matching files', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'b');
    fs.writeFileSync(path.join(workspace, 'c.log'), 'c');

    const resolved = await resolvePaths([path.join(workspace, '*.txt')]);
    expect(resolved.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('anchors relative patterns at GITHUB_WORKSPACE', async () => {
    fs.writeFileSync(path.join(workspace, 'rel.txt'), 'rel');
    const resolved = await resolvePaths(['rel.txt']);
    expect(resolved).toEqual(['rel.txt']);
  });

  it('throws ValidationError when no paths match', async () => {
    await expect(resolvePaths([path.join(workspace, 'does-not-exist-*')])).rejects.toThrow(
      ValidationError
    );
  });
});

describe('createTempDirectory', () => {
  it('creates a new unique directory that exists', async () => {
    const dir1 = await createTempDirectory();
    const dir2 = await createTempDirectory();

    expect(fs.existsSync(dir1)).toBe(true);
    expect(fs.existsSync(dir2)).toBe(true);
    expect(dir1).not.toBe(dir2);

    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
