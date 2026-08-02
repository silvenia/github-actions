export interface S3Config {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    bucket: string;
    forcePathStyle: boolean;
    chunkSize?: number;
}
export interface CacheObjectMetadata {
    cacheKey: string;
    cacheVersion: string;
    platform: string;
    size: number;
}
export interface CacheObject {
    key: string;
    metadata: CacheObjectMetadata;
    size: number;
    lastModified: Date;
}
export declare function buildRcloneEnv(config: S3Config): Record<string, string>;
export declare function remote(config: S3Config, key: string): string;
export declare function execRclone(args: string[], config: S3Config): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export declare function putCacheObject(config: S3Config, key: string, archivePath: string, metadata: CacheObjectMetadata): Promise<void>;
export declare function statCacheObject(config: S3Config, key: string): Promise<CacheObject | null>;
export declare function downloadCacheObject(config: S3Config, key: string, destPath: string): Promise<void>;
export declare function listCacheObjects(config: S3Config, prefix: string): Promise<CacheObject[]>;
export declare function deleteCacheObject(config: S3Config, key: string): Promise<void>;
