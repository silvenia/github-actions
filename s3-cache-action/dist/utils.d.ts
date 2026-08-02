export declare enum CompressionMethod {
    Gzip = "gzip",
    Zstd = "zstd",
    ZstdWithoutLong = "zstd-without-long"
}
export declare class ValidationError extends Error {
    constructor(message: string);
}
export declare function isExactKeyMatch(key: string, cacheKey: string | undefined): boolean;
export declare function getInputAsArray(name: string): string[];
export declare function getInputAsBool(name: string): boolean;
export declare function getInputAsInt(name: string): number | undefined;
export declare function logWarning(message: string): void;
export declare function validateKey(key: string): void;
export declare function validatePaths(paths: string[]): void;
export declare function getCompressionMethod(): Promise<CompressionMethod>;
export declare function getCacheFileName(compressionMethod: CompressionMethod): string;
export declare function getCacheVersion(paths: string[], compressionMethod: CompressionMethod | undefined, enableCrossOsArchive: boolean): string;
