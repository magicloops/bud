import { createHash, randomUUID } from 'node:crypto';
import { constants, access, link, lstat, mkdir, open, opendir, readFile, realpath, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { assertFileId, FileError, MAX_FILE_BYTES } from './contracts.js';

type FileReceipt = { size_bytes: number; sha256: string };
export interface FileObjects {
  prepare(): Promise<void>;
  receive(id: string, size: number, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<FileReceipt>;
  get(id: string): Promise<Readable>;
  remove(id: string): Promise<void>;
}

export const DISK_FREE_RESERVE_BYTES = 256 * 1024 * 1024;
const STAGING_TTL_MS = 60 * 60 * 1000;

/** Production never silently writes into the service's ephemeral filesystem. */
export function fileStorageOptions(env: NodeJS.ProcessEnv = process.env): { directory: string; mountPath: string | undefined } {
  const directory = env.FILE_STORAGE_DIRECTORY;
  const mountPath = env.FILE_STORAGE_MOUNT_PATH;
  if (env.NODE_ENV === 'production' && (!directory || !mountPath)) {
    throw new FileError('file_storage_unconfigured', 503);
  }
  if (mountPath) {
    if (!directory || !isAbsolute(directory) || !isAbsolute(mountPath) || resolve(mountPath) === sep) {
      throw new FileError('file_storage_invalid_directory', 503);
    }
    const child = relative(resolve(mountPath), resolve(directory));
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new FileError('file_storage_invalid_directory', 503);
    }
  }
  return { directory: resolve(directory ?? '.bud-data/files'), mountPath: mountPath ? resolve(mountPath) : undefined };
}

/** Linux mountinfo distinguishes real mounts from ordinary folders/bind roots. */
export function hasWritablePersistentMount(mountInfo: string, mountPath: string): boolean {
  return mountInfo.split('\n').some(line => {
    const [mount, filesystem] = line.split(' - ');
    const fields = mount.split(' ');
    const path = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const [type, , superOptions] = filesystem?.split(' ') ?? [];
    return path === mountPath && fields[5]?.split(',').includes('rw') && Boolean(type) &&
      Boolean(superOptions?.split(',').includes('rw')) &&
      !['tmpfs', 'ramfs', 'overlay', 'rootfs'].includes(type!);
  });
}

/** Filename is presentation metadata; only server-minted IDs enter storage paths. */
export class LocalFileObjects implements FileObjects {
  private initialization?: Promise<void>;
  private reservedBytes = 0;
  private lastCleanup = 0;
  constructor(private readonly directory = resolve(process.env.FILE_STORAGE_DIRECTORY ?? '.bud-data/files'),
    private readonly mountPath?: string) {}
  private path(id: string) { assertFileId(id); return join(this.directory, id); }

  async prepare(): Promise<void> {
    // Repeat the mount check so a missing/unmounted volume never falls back to
    // the directory underneath it. Production targets the Linux Render runtime.
    if (this.mountPath) {
      const mounted = process.platform === 'linux' &&
        hasWritablePersistentMount(await readFile('/proc/self/mountinfo', 'utf8'), this.mountPath);
      if (!mounted || await realpath(this.mountPath) !== this.mountPath) {
        throw new FileError('file_storage_mount_unavailable', 503);
      }
    }
    this.initialization ??= this.initialize().catch(error => { this.initialization = undefined; throw error; });
    await this.initialization;
    if (Date.now() - this.lastCleanup >= STAGING_TTL_MS) {
      this.lastCleanup = Date.now();
      await this.cleanupStaging();
    }
  }

  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.mountPath && await realpath(this.directory) !== this.directory) {
      throw new FileError('file_storage_invalid_directory', 503);
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = await directory.stat();
      if (process.getuid && metadata.uid !== process.getuid()) throw new FileError('file_storage_invalid_owner', 503);
      await directory.chmod(0o700);
    } finally { await directory.close(); }
    await access(this.directory, constants.R_OK | constants.W_OK | constants.X_OK);
    const parent = await open(dirname(this.directory), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
  }

  private async cleanupStaging() {
    const entries = await opendir(this.directory);
    for await (const entry of entries) {
      if (!/^\.upload-[0-9a-f-]{36}$/.test(entry.name) || !entry.isFile()) continue;
      const path = join(this.directory, entry.name);
      const metadata = await lstat(path).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (metadata && metadata.mtimeMs < Date.now() - STAGING_TTL_MS) await rm(path, { force: true });
    }
  }

  protected async availableBytes(): Promise<bigint> {
    const space = await statfs(this.directory, { bigint: true });
    return space.bavail * space.bsize;
  }

  private async syncDirectory() {
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async receive(id: string, expectedSize: number, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<FileReceipt> {
    const target = this.path(id);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_FILE_BYTES) {
      throw new FileError('file_too_large', 413);
    }
    await this.prepare();
    // Reservations include all concurrent uploads, even while waiting for statfs.
    // Written bytes may be counted twice briefly, conservatively preserving headroom.
    this.reservedBytes += expectedSize;
    const staging = join(this.directory, `.upload-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (await this.availableBytes() < BigInt(this.reservedBytes + DISK_FREE_RESERVE_BYTES)) {
        throw new FileError('file_storage_full', 507);
      }
      signal?.throwIfAborted();
      handle = await open(staging, 'wx', 0o600);
      let size = 0;
      const hash = createHash('sha256');
      for await (const chunk of source) {
        signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > expectedSize) throw new FileError('file_size_mismatch', 413);
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (size !== expectedSize) throw new FileError('file_size_mismatch');
      signal?.throwIfAborted();
      await handle.sync();
      await handle.close(); handle = undefined;
      // Hard-link publication is atomic, stays on this volume and refuses to
      // overwrite an existing file or symlink. There is no second byte copy.
      await link(staging, target);
      await this.syncDirectory();
      return { size_bytes: size, sha256: hash.digest('hex') };
    } catch (error) {
      if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new FileError('file_storage_full', 507);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      await rm(staging, { force: true }).catch(() => {});
      this.reservedBytes -= expectedSize;
    }
  }

  async get(id: string): Promise<Readable> {
    const path = this.path(id);
    await this.prepare();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat().catch(async error => { await handle.close(); throw error; });
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
      await handle.close(); throw new FileError('file_unavailable', 409);
    }
    return handle.createReadStream();
  }
  async remove(id: string): Promise<void> {
    const path = this.path(id);
    await this.prepare();
    await rm(path, { force: true });
    await this.syncDirectory();
  }
}

let configured: FileObjects | undefined;
export function fileObjects(): FileObjects {
  if (configured) return configured;
  const { directory, mountPath } = fileStorageOptions();
  configured = new LocalFileObjects(directory, mountPath);
  return configured;
}

export async function originalBytes(objects: FileObjects, id: string, size: number, sha256: string): Promise<Buffer> {
  const source = await objects.get(id), chunks: Buffer[] = [];
  let received = 0;
  const hash = createHash('sha256');
  try {
    for await (const value of source) {
      const chunk = Buffer.from(value); received += chunk.length;
      if (received > size || received > MAX_FILE_BYTES) throw new FileError('file_integrity_failed', 409);
      chunks.push(chunk); hash.update(chunk);
    }
    if (received !== size || hash.digest('hex') !== sha256) throw new FileError('file_integrity_failed', 409);
    return Buffer.concat(chunks, received);
  } finally { source.destroy(); }
}
