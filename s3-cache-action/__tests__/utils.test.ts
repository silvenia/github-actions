import { ARCHIVE_FORMAT, getCacheVersion, validateKey, validatePaths, ValidationError } from '../src/utils';

describe('validateKey', () => {
  it('rejects an empty key', () => {
    expect(() => validateKey('')).toThrow(ValidationError);
  });

  it('rejects keys longer than 512 characters', () => {
    expect(() => validateKey('a'.repeat(513))).toThrow(ValidationError);
  });

  it('rejects keys containing commas', () => {
    expect(() => validateKey('a,b')).toThrow(ValidationError);
  });

  it('rejects keys with consecutive forward slashes', () => {
    expect(() => validateKey('a//b')).toThrow(ValidationError);
  });

  it('accepts a valid key', () => {
    expect(() => validateKey('linux-npm-abc123')).not.toThrow();
  });
});

describe('validatePaths', () => {
  it('rejects empty paths', () => {
    expect(() => validatePaths([])).toThrow(ValidationError);
  });
});

describe('getCacheVersion', () => {
  it('is deterministic for the same inputs', () => {
    expect(getCacheVersion(['p1'], false)).toBe(getCacheVersion(['p1'], false));
  });

  it('differs when paths differ', () => {
    expect(getCacheVersion(['p1'], false)).not.toBe(getCacheVersion(['p2'], false));
  });

  it('differs when cross-os archive is enabled on win32', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(getCacheVersion(['p1'], false)).not.toBe(getCacheVersion(['p1'], true));
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('uses the 7z archive format', () => {
    expect(ARCHIVE_FORMAT).toBe('7z');
  });
});
