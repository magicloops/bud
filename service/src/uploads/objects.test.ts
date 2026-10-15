import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { ulid } from 'ulid';
import { DISK_FREE_RESERVE_BYTES, LocalFileObjects, fileStorageOptions,
  hasWritablePersistentMount, originalBytes } from './objects.js';

const id = () => `file_${ulid()}`;
const errorCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('production requires an explicit directory strictly below its persistent mount', () => {
  for (const env of [
    {}, { FILE_STORAGE_DIRECTORY: '/var/data/uploads' },
    { FILE_STORAGE_MOUNT_PATH: '/var/data' },
    { FILE_STORAGE_MOUNT_PATH: '/', FILE_STORAGE_DIRECTORY: '/uploads' },
    { FILE_STORAGE_MOUNT_PATH: 'data', FILE_STORAGE_DIRECTORY: '/data/uploads' },
    { FILE_STORAGE_MOUNT_PATH: '/var/data', FILE_STORAGE_DIRECTORY: 'uploads' },
    { FILE_STORAGE_MOUNT_PATH: '/var/data', FILE_STORAGE_DIRECTORY: '/var/data' },
    { FILE_STORAGE_MOUNT_PATH: '/var/data', FILE_STORAGE_DIRECTORY: '/var/data/../uploads' },
    { FILE_STORAGE_MOUNT_PATH: '/var/data', FILE_STORAGE_DIRECTORY: '/var/database/uploads' },
  ]) assert.throws(() => fileStorageOptions({ NODE_ENV: 'production', ...env }), /file_storage_/);
  assert.deepEqual(fileStorageOptions({ NODE_ENV: 'production', FILE_STORAGE_DIRECTORY: '/var/data/uploads',
    FILE_STORAGE_MOUNT_PATH: '/var/data' }), { directory: '/var/data/uploads', mountPath: '/var/data' });
  assert.deepEqual(fileStorageOptions({ NODE_ENV: 'development' }),
    { directory: resolve('.bud-data/files'), mountPath: undefined });
});

test('mount evidence rejects ordinary folders, read-only and ephemeral filesystems', () => {
  const root = '28 1 0:22 / / rw,relatime - overlay overlay rw';
  const disk = '30 28 8:1 / /var/data rw,relatime - ext4 /dev/sdb rw';
  assert.equal(hasWritablePersistentMount(`${root}\n${disk}`, '/var/data'), true);
  assert.equal(hasWritablePersistentMount(disk, '/var/data/uploads'), false);
  assert.equal(hasWritablePersistentMount(root, '/var/data'), false);
  assert.equal(hasWritablePersistentMount(disk.replace('rw,relatime', 'ro,relatime'), '/var/data'), false);
  assert.equal(hasWritablePersistentMount(disk.replace('/dev/sdb rw', '/dev/sdb ro'), '/var/data'), false);
  for (const type of ['tmpfs', 'ramfs', 'overlay', 'rootfs']) {
    assert.equal(hasWritablePersistentMount(disk.replace('ext4', type), '/var/data'), false);
  }
  assert.equal(hasWritablePersistentMount(disk.replace('/var/data', '/var/my\\040data'), '/var/my data'), true);
});

test('a configured but missing mount fails before creating upload directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bud-missing-mount-'));
  try {
    await assert.rejects(new LocalFileObjects(join(root, 'uploads'), root).prepare(), /mount_unavailable/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private originals appear atomically, survive reopening and cannot be overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bud-disk-'));
  const objects = new LocalFileObjects(root), fileId = id(), staged = gate(), finish = gate();
  const bytes = Buffer.from('unchanged original');
  try {
    const upload = objects.receive(fileId, bytes.length, (async function* () {
      yield bytes.subarray(0, 4); staged.release(); await finish.promise; yield bytes.subarray(4);
    })());
    await staged.promise;
    try {
      await assert.rejects(objects.get(fileId), errorCode('ENOENT'));
      const names = await readdir(root);
      assert.equal(names.length, 1); assert.match(names[0], /^\.upload-/);
      assert.equal((await stat(join(root, names[0]))).mode & 0o777, 0o600);
      assert.equal((await stat(root)).mode & 0o777, 0o700);
    } finally { finish.release(); }
    const receipt = await upload;
    assert.deepEqual(await readdir(root), [fileId]);
    assert.equal((await stat(join(root, fileId))).mode & 0o777, 0o600);
    const reopened = new LocalFileObjects(root);
    assert.deepEqual(await originalBytes(reopened, fileId, bytes.length, receipt.sha256), bytes);
    await assert.rejects(reopened.receive(fileId, bytes.length, Readable.from([bytes])), errorCode('EEXIST'));
    assert.deepEqual(await readFile(join(root, fileId)), bytes);
    const alias = id(); await symlink(join(root, fileId), join(root, alias));
    await assert.rejects(reopened.get(alias));
    await assert.rejects(reopened.receive(alias, bytes.length, Readable.from([bytes])), errorCode('EEXIST'));
    await reopened.remove(alias);
    assert.deepEqual(await readFile(join(root, fileId)), bytes);
    await reopened.remove(fileId);
    assert.deepEqual(await readdir(root), []);
  } finally { finish.release(); await rm(root, { recursive: true, force: true }); }
});

test('interrupted, canceled, oversized and disk-full writes remove staging without publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bud-disk-failure-'));
  const objects = new LocalFileObjects(root);
  try {
    for (const code of ['interrupted', 'ENOSPC', 'EDQUOT']) {
      await assert.rejects(objects.receive(id(), 10, (async function* () {
        yield Buffer.from('partial'); throw Object.assign(new Error(code), { code });
      })()), code === 'interrupted' ? /interrupted/ : errorCode('file_storage_full'));
      assert.deepEqual(await readdir(root), []);
    }
    const controller = new AbortController();
    await assert.rejects(objects.receive(id(), 10, (async function* () {
      yield Buffer.from('partial'); controller.abort(); yield Buffer.from('end');
    })(), controller.signal), { name: 'AbortError' });
    await assert.rejects(objects.receive(id(), 1, Readable.from([Buffer.from('too much')])), /size_mismatch/);
    await assert.rejects(objects.receive(id(), 10, Readable.from([Buffer.from('short')])), /size_mismatch/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent uploads reserve capacity and release it after success and rejection', async () => {
  class SmallDisk extends LocalFileObjects {
    protected override async availableBytes() { return BigInt(DISK_FREE_RESERVE_BYTES + 10); }
  }
  const root = await mkdtemp(join(tmpdir(), 'bud-disk-capacity-'));
  const objects = new SmallDisk(root), staged = gate(), finish = gate();
  try {
    const upload = objects.receive(id(), 8, (async function* () {
      yield Buffer.from('first'); staged.release(); await finish.promise; yield Buffer.from('end');
    })());
    await staged.promise;
    try {
      await assert.rejects(objects.receive(id(), 8, Readable.from([Buffer.alloc(8)])), errorCode('file_storage_full'));
    } finally { finish.release(); }
    await upload;
    await objects.receive(id(), 10, Readable.from([Buffer.alloc(10)]));
    assert.equal((await readdir(root)).length, 2);
  } finally { finish.release(); await rm(root, { recursive: true, force: true }); }
});

test('cleanup expires abandoned staging only; symlinked storage directories are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bud-disk-cleanup-'));
  const alias = `${root}-link`, stale = `.upload-${randomUUID()}`, fresh = `.upload-${randomUUID()}`, original = id();
  try {
    for (const name of [stale, fresh, original]) await writeFile(join(root, name), 'keep except stale');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(root, stale), old, old); await utimes(join(root, original), old, old);
    await new LocalFileObjects(root).prepare();
    assert.deepEqual((await readdir(root)).sort(), [fresh, original].sort());
    await symlink(root, alias);
    await assert.rejects(new LocalFileObjects(alias).prepare());
  } finally { await rm(alias, { force: true }); await rm(root, { recursive: true, force: true }); }
});
