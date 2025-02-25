/**
 * 4.4.5
 */
export declare enum CompressionMethod {
    STORED = 0,
    SHRUNK = 1,
    REDUCED_1 = 2,
    REDUCED_2 = 3,
    REDUCED_3 = 4,
    REDUCED_4 = 5,
    IMPLODE = 6,
    DEFLATE = 8,
    DEFLATE64 = 9,
    TERSE_OLD = 10,
    BZIP2 = 12,
    LZMA = 14,
    TERSE_NEW = 18,
    LZ77 = 19,
    WAVPACK = 97,
    PPMD = 98
}
export type decompress = (data: ArrayBufferLike, compressedSize: number, uncompressedSize: number, flags: number) => Uint8Array;
/**
 * Maps CompressionMethod to function that decompresses.
 */
export declare const decompressionMethods: {
    [method in CompressionMethod]?: decompress;
};
