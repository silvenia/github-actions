import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandTilde, resolvePaths, createCacheArchive, extractCacheArchive } from '../src/cache';
import { ValidationError } from '../src/utils';

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

describe('expandTilde', () => {
  it('expands a bare tilde to the home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  it('expands a tilde-prefixed path', () => {
    expect(expandTilde('~/foo')).toBe(path.join(os.homedir(), 'foo'));
  });

  it('leaves other patterns unchanged', () => {
    expect(expandTilde('node_modules')).toBe('node_modules');
    expect(expandTilde('/abs/path')).toBe('/abs/path');
  });
});

describe('resolvePaths', () => {
  it('anchors relative patterns at the workspace', async () => {
    fs.writeFileSync(path.join(workspace, 'file1.txt'), 'hello');
    const resolved = await resolvePaths(['file1.txt']);
    expect(resolved).toEqual([path.join(workspace, 'file1.txt')]);
  });

  it('expands tilde patterns to the home directory', async () => {
    fs.mkdirSync(path.join(os.homedir(), '.test-cache-dir'), { recursive: true });
    try {
      const resolved = await resolvePaths(['~/.test-cache-dir']);
      expect(resolved).toEqual([path.join(os.homedir(), '.test-cache-dir')]);
    } finally {
      fs.rmSync(path.join(os.homedir(), '.test-cache-dir'), { recursive: true, force: true });
    }
  });

  it('throws when no files match', async () => {
    await expect(resolvePaths(['does-not-exist'])).rejects.toThrow(ValidationError);
  });
});

describe('createCacheArchive / extractCacheArchive', () => {
  it('round-trips files through a 7z archive', async () => {
    const source = path.join(workspace, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'file1.txt'), 'hello world');
    fs.mkdirSync(path.join(source, 'sub'));
    fs.writeFileSync(path.join(source, 'sub', 'file2.txt'), 'nested');

    const archivePath = await createCacheArchive(archiveFolder, [source]);
    expect(fs.existsSync(archivePath)).toBe(true);

    fs.rmSync(source, { recursive: true, force: true });

    await extractCacheArchive(archivePath);

    expect(fs.readFileSync(path.join(source, 'file1.txt'), 'utf8')).toBe('hello world');
    expect(fs.readFileSync(path.join(source, 'sub', 'file2.txt'), 'utf8')).toBe('nested');
  });

  it('round-trips hard linked files with content intact', async () => {
    const source = path.join(workspace, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'file1.txt'), 'linked-content');
    fs.linkSync(path.join(source, 'file1.txt'), path.join(source, 'file2.txt'));

    const archivePath = await createCacheArchive(archiveFolder, [source]);
    fs.rmSync(source, { recursive: true, force: true });
    await extractCacheArchive(archivePath);

    // 7-Zip preserves hard links on Windows (NTFS); on Linux the entries are
    // stored as separate copies. Both forms must restore readable content.
    expect(fs.readFileSync(path.join(source, 'file1.txt'), 'utf8')).toBe('linked-content');
    expect(fs.readFileSync(path.join(source, 'file2.txt'), 'utf8')).toBe('linked-content');
  });
});
