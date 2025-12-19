// SPDX-License-Identifier: LGPL-3.0-or-later
import { FileSystem, Inode, type UsageInfo } from '@lvcabral/zenfs';
import type { Backend } from '@lvcabral/zenfs/backends/backend.js';
import type { CaseFold } from '@lvcabral/zenfs/internal/filesystem.js';
import { S_IFDIR, S_IFREG } from '@lvcabral/zenfs/constants';
import { Readonly } from '@lvcabral/zenfs/mixins/readonly.js';
import { parse } from '@lvcabral/zenfs/path';
import { withErrno } from 'kerium';
import { err } from 'kerium/log';
import { _throw } from 'utilium';
import type { Header } from './zip.js';
import { computeEOCD, computeEOCDSync, FileEntry } from './zip.js';

export interface ZipDataSource<TBuffer extends ArrayBufferLike = ArrayBuffer> {
	readonly size: number;
	get(offset: number, length: number): Uint8Array<TBuffer> | Promise<Uint8Array<TBuffer>>;
	set?(offset: number, data: ArrayBufferView<TBuffer>): void | Promise<void>;
}

/**
 * Configuration options for a ZipFS file system.
 */
export interface ZipOptions<TBuffer extends ArrayBufferLike = ArrayBuffer> {
	/**
	 * The zip file as a binary buffer.
	 */
	data: TBuffer | ArrayBufferView<TBuffer> | ZipDataSource<TBuffer>;

	/**
	 * The name of the zip file (optional).
	 */
	name?: string;

	/**
	 * Whether to wait to initialize entries
	 */
	lazy?: boolean;

	/**
	 * Case folding mode for file names (optional).
	 * Can be 'lower', or 'upper'.
	 * Default is undefined.
	 */
	caseFold?: CaseFold;
}

/**
 * A file system backend by a zip file.
 * Implemented according to the standard:
 * http://pkware.com/documents/casestudies/APPNOTE.TXT
 *
 * While there are a few zip libraries for JavaScript (e.g. JSZip and zip.js),
 * they are not a good match for ZenFS. In particular, these libraries
 * perform a lot of unneeded data copying, and eagerly decompress every file
 * in the zip file upon loading to check the CRC32. They also eagerly decode
 * strings. Furthermore, these libraries duplicate functionality already present
 * in ZenFS (e.g. UTF-8 decoding and binary data manipulation).
 *
 * When the filesystem is instantiated,
 * we determine the directory structure of the zip file as quickly as possible.
 * We lazily decompress and check the CRC32 of files.
 *
 * Current limitations:
 * * No encryption.
 * * No ZIP64 support.
 * * Read-only.
 *   Write support would require that we:
 *   - Keep track of changed/new files.
 *   - Compress changed files, and generate appropriate metadata for each.
 *   - Update file offsets for other files in the zip file.
 *   - Stream it out to a location.
 *   This isn't that bad, so we might do this at a later date.
 */
export class ZipFS<TBuffer extends ArrayBufferLike = ArrayBuffer> extends Readonly(FileSystem) {
	protected files: Map<string, FileEntry<TBuffer>> = new Map();
	protected directories: Map<string, Set<string>> = new Map();
	protected folded: Map<string, string> = new Map();

	protected _time = Date.now();
	private _ready: boolean = false;

	protected eocd!: Header<TBuffer>;

	public async ready(): Promise<void> {
		await super.ready();

		if (this._ready) return;
		this._ready = true;

		this.eocd = await computeEOCD(this.data);
		this._assertSupportedArchive(this.eocd);

		let ptr = this.eocd.offset;
		const cdEnd = ptr + this.eocd.size;

		while (ptr < cdEnd) {
			const cd = await FileEntry.from<TBuffer>(this.data, ptr);

			if (!this.lazy) await cd.loadContents();
			this._registerEntry(cd);
			ptr += cd.size;
		}

		this._buildDirectoryIndex();
	}

	public readySync(): void {
		if (this._ready) return;
		this._ready = true;

		this.eocd = computeEOCDSync(this.data);
		this._assertSupportedArchive(this.eocd);

		let ptr = this.eocd.offset;
		const cdEnd = ptr + this.eocd.size;

		while (ptr < cdEnd) {
			const cd = FileEntry.fromSync<TBuffer>(this.data, ptr);

			if (!this.lazy) cd.loadContentsSync();
			this._registerEntry(cd);
			ptr += cd.size;
		}

		this._buildDirectoryIndex();
	}

	private _assertSupportedArchive(header: Header<TBuffer>): void {
		if (header.disk != header.entriesDisk) {
			throw withErrno('EINVAL', 'ZipFS does not support spanned zip files.');
		}
		if (header.offset === 0xffffffff) {
			throw withErrno('EINVAL', 'ZipFS does not support Zip64.');
		}
	}

	private _registerEntry(entry: FileEntry<TBuffer>): void {
		if (entry.name.startsWith('/')) {
			throw withErrno('EPERM', 'Unexpectedly encountered an absolute path in a zip file.');
		}

		const name = entry.name.endsWith('/') ? '/' + entry.name.slice(0, -1) : '/' + entry.name;
		this.files.set(this._caseFold(name, true), entry);
	}

	private _buildDirectoryIndex(): void {
		this.directories.clear();

		for (const entry of this.files.keys()) {
			const name = this.folded.get(entry) ?? entry;
			let current = name;

			while (true) {
				const { dir, base } = parse(current);
				if (base == '') break;

				const foldedDir = this._caseFold(dir, true);
				if (!this.directories.has(foldedDir)) {
					this.directories.set(foldedDir, new Set());
				}

				this.directories.get(foldedDir)!.add(base);
				current = dir;
			}
		}
	}

	public constructor(
		public label: string,
		protected data: ZipDataSource<TBuffer>,
		public readonly lazy: boolean = false,
		public readonly caseFold?: CaseFold
	) {
		super(0x207a6970, 'zipfs');
	}

	public usage(): UsageInfo {
		return {
			totalSpace: this.data.size,
			freeSpace: 0,
		};
	}

	public async stat(path: string): Promise<Inode> {
		return this.statSync(path);
	}

	public statSync(path: string): Inode {
		const folded = this._caseFold(path);
		// The EOCD/Header does not track directories, so it does not exist in `entries`
		if (this.directories.has(folded)) {
			return new Inode({
				mode: 0o555 | S_IFDIR,
				size: 4096,
				mtimeMs: this._time,
				ctimeMs: this._time,
				atimeMs: Date.now(),
				birthtimeMs: this._time,
			});
		}

		const entry = this.files.get(folded);

		if (!entry) throw withErrno('ENOENT');

		return new Inode({
			mode: 0o555 | (entry.isDirectory ? S_IFDIR : S_IFREG),
			size: entry.uncompressedSize,
			mtimeMs: entry.lastModified.getTime(),
		});
	}

	public async readdir(path: string): Promise<string[]> {
		const inode = await this.stat(path);
		if (!(inode.mode & S_IFDIR)) throw withErrno('ENOTDIR');

		const entries = this.directories.get(this._caseFold(path));
		if (!entries) throw withErrno('ENODATA');

		return Array.from(entries).map(entry => {
			return this.folded.get(entry) ?? entry;
		});
	}

	public readdirSync(path: string): string[] {
		const inode = this.statSync(path);
		if (!(inode.mode & S_IFDIR)) throw withErrno('ENOTDIR');

		const entries = this.directories.get(this._caseFold(path));
		if (!entries) throw withErrno('ENODATA');

		return Array.from(entries).map(entry => {
			return this.folded.get(entry) ?? entry;
		});
	}

	public async read(path: string, buffer: Uint8Array, offset: number, end: number): Promise<void> {
		const folded = this._caseFold(path);
		if (this.directories.has(folded)) throw withErrno('EISDIR');

		const file = this.files.get(folded) ?? _throw(withErrno('ENOENT'));

		if (!file.contents) await file.loadContents();

		buffer.set(file.contents.subarray(offset, end));
	}

	public readSync(path: string, buffer: Uint8Array, offset: number, end: number): void {
		const folded = this._caseFold(path);
		if (this.directories.has(folded)) throw withErrno('EISDIR');

		const file = this.files.get(folded) ?? _throw(withErrno('ENOENT'));

		if (!file.contents) {
			void file.loadContents();
			throw withErrno('EAGAIN');
		}

		buffer.set(file.contents.subarray(offset, end));
	}

	private _caseFold(original: string, update: boolean = false): string {
		if (this.caseFold) {
			const folded = this.caseFold == 'upper' ? original.toUpperCase() : original.toLowerCase();
			if (update && !this.folded.has(folded) && folded !== original) {
				this.folded.set(folded, original);
			}
			return folded;
		}
		return original;
	}
}

const _isShared = (b: unknown): b is SharedArrayBuffer => typeof b == 'object' && b !== null && b.constructor.name === 'SharedArrayBuffer';

export function fromStream(stream: ReadableStream<Uint8Array>, size: number): ZipDataSource<ArrayBuffer> {
	const data = new Uint8Array(size);

	let bytesRead = 0;
	const pending = new Set<{
		resolve(value: void | PromiseLike<void>): void;
		offset: number;
		length: number;
	}>();

	const allDone = (async function __read() {
		for await (const chunk of stream) {
			data.set(chunk, bytesRead);
			bytesRead += chunk.byteLength;
			for (const promise of pending) {
				if (bytesRead >= promise.offset + promise.length) {
					promise.resolve();
					pending.delete(promise);
				}
			}
		}
	})();

	return {
		size,
		async get(offset, length) {
			const view = data.subarray(offset, offset + length);
			if (bytesRead >= offset + length) return view;
			const { promise, resolve } = Promise.withResolvers<void>();

			pending.add({ resolve, offset, length });
			await promise;
			return view;
		},
	};
}

function getSource<TBuffer extends ArrayBufferLike = ArrayBuffer>(input: ZipOptions<TBuffer>['data']): ZipDataSource<TBuffer> {
	if (input instanceof ArrayBuffer || _isShared(input)) {
		return {
			size: input.byteLength,
			get(offset: number, length: number) {
				return new Uint8Array(input, offset, length);
			},
			set(offset, data) {
				new Uint8Array(input, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			},
		};
	}

	if (ArrayBuffer.isView(input)) {
		return {
			size: input.byteLength,
			get(offset: number, length: number) {
				return new Uint8Array(input.buffer, input.byteOffset + offset, length);
			},
			set(offset, data) {
				new Uint8Array(input.buffer, input.byteOffset + offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			},
		};
	}

	if (typeof input == 'object' && input !== null && 'size' in input && typeof input.size == 'number' && typeof input.get == 'function') {
		return input;
	}

	throw err(withErrno('EINVAL', 'Invalid zip data source'));
}

const _Zip = {
	name: 'Zip',

	options: {
		data: { type: 'object', required: true },
		name: { type: 'string', required: false },
		lazy: { type: 'boolean', required: false },
	},

	isAvailable(): boolean {
		return true;
	},

	create<TBuffer extends ArrayBufferLike = ArrayBuffer>(opt: ZipOptions<TBuffer>): ZipFS<TBuffer> {
		return new ZipFS<TBuffer>(opt.name ?? '', getSource(opt.data), opt.lazy, opt.caseFold);
	},
} satisfies Backend<ZipFS, ZipOptions>;
type _Zip = typeof _Zip;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Zip extends _Zip {}
export const Zip: Zip = _Zip;
