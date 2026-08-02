import { CompressionMethod } from './utils';
export declare function resolvePaths(patterns: string[]): Promise<string[]>;
export declare function createTar(archiveFolder: string, sourcePaths: string[], compressionMethod: CompressionMethod): Promise<string>;
export declare function extractTar(archivePath: string, compressionMethod: CompressionMethod): Promise<void>;
export declare function createTempDirectory(): Promise<string>;
export declare function getArchiveFileSizeInBytes(filePath: string): number;
