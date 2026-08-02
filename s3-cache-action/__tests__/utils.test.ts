jest.mock('@actions/core');
import * as core from '@actions/core';
import {
  CompressionMethod,
  ValidationError,
  getCacheFileName,
  getCacheVersion,
  getInputAsArray,
  getInputAsBool,
  getInputAsInt,
  isExactKeyMatch,
  validateKey,
  validatePaths
} from '../src/utils';

describe('isExactKeyMatch', () => {
  it('returns true for an exact match', () => {
    expect(isExactKeyMatch('key1', 'key1')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isExactKeyMatch('Key1', 'key1')).toBe(true);
  });

  it('returns false for no match', () => {
    expect(isExactKeyMatch('key1', 'key2')).toBe(false);
  });

  it('returns false when cacheKey is undefined', () => {
    expect(isExactKeyMatch('key1', undefined)).toBe(false);
  });
});

describe('validateKey', () => {
  it('throws ValidationError for an empty key', () => {
    expect(() => validateKey('')).toThrow(ValidationError);
  });

  it('throws ValidationError for a key longer than 512 characters', () => {
    expect(() => validateKey('a'.repeat(513))).toThrow(ValidationError);
  });

  it('throws ValidationError for a key containing a comma', () => {
    expect(() => validateKey('key,1')).toThrow(ValidationError);
  });

  it('throws ValidationError for a key containing consecutive forward slashes', () => {
    expect(() => validateKey('a//b')).toThrow(ValidationError);
  });

  it('does not throw for a valid key', () => {
    expect(() => validateKey('valid-key-123')).not.toThrow();
  });
});

describe('validatePaths', () => {
  it('throws ValidationError for an empty array', () => {
    expect(() => validatePaths([])).toThrow(ValidationError);
  });

  it('does not throw for a valid array', () => {
    expect(() => validatePaths(['p1', 'p2'])).not.toThrow();
  });
});

describe('getInputAsArray', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (core.getInput as jest.Mock).mockReturnValue('');
  });

  it('parses a single line', () => {
    (core.getInput as jest.Mock).mockReturnValue('p1');
    expect(getInputAsArray('path')).toEqual(['p1']);
  });

  it('parses multiple lines', () => {
    (core.getInput as jest.Mock).mockReturnValue('p1\np2\np3');
    expect(getInputAsArray('path')).toEqual(['p1', 'p2', 'p3']);
  });

  it('filters empty lines', () => {
    (core.getInput as jest.Mock).mockReturnValue('p1\n\np2');
    expect(getInputAsArray('path')).toEqual(['p1', 'p2']);
  });
});

describe('getInputAsBool', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns true for "true"', () => {
    (core.getInput as jest.Mock).mockReturnValue('true');
    expect(getInputAsBool('enableCrossOsArchive')).toBe(true);
  });

  it('returns false for "false"', () => {
    (core.getInput as jest.Mock).mockReturnValue('false');
    expect(getInputAsBool('enableCrossOsArchive')).toBe(false);
  });

  it('is case insensitive for uppercase TRUE', () => {
    (core.getInput as jest.Mock).mockReturnValue('TRUE');
    expect(getInputAsBool('enableCrossOsArchive')).toBe(true);
  });
});

describe('getInputAsInt', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('parses a valid integer', () => {
    (core.getInput as jest.Mock).mockReturnValue('10485760');
    expect(getInputAsInt('upload-chunk-size')).toBe(10485760);
  });

  it('returns undefined for a non-numeric value', () => {
    (core.getInput as jest.Mock).mockReturnValue('abc');
    expect(getInputAsInt('upload-chunk-size')).toBeUndefined();
  });

  it('returns undefined for a negative value', () => {
    (core.getInput as jest.Mock).mockReturnValue('-1');
    expect(getInputAsInt('upload-chunk-size')).toBeUndefined();
  });
});

describe('getCacheVersion', () => {
  it('is deterministic for the same inputs', () => {
    const first = getCacheVersion(['p1'], CompressionMethod.Gzip, false);
    const second = getCacheVersion(['p1'], CompressionMethod.Gzip, false);
    expect(first).toBe(second);
  });

  it('differs when the compression method changes', () => {
    const gzip = getCacheVersion(['p1'], CompressionMethod.Gzip, false);
    const zstd = getCacheVersion(['p1'], CompressionMethod.Zstd, false);
    expect(gzip).not.toBe(zstd);
  });
});

describe('getCacheFileName', () => {
  it('returns cache.tgz for gzip', () => {
    expect(getCacheFileName(CompressionMethod.Gzip)).toBe('cache.tgz');
  });

  it('returns cache.tzst for zstd', () => {
    expect(getCacheFileName(CompressionMethod.Zstd)).toBe('cache.tzst');
  });

  it('returns cache.tzst for zstd-without-long', () => {
    expect(getCacheFileName(CompressionMethod.ZstdWithoutLong)).toBe('cache.tzst');
  });
});
