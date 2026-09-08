// Standalone Node backend helper. Public setup metadata may be printed; this
// module never returns or logs installation private keys or query credentials.
import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPair, privateDecrypt, randomUUID, sign } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const generate = promisify(generateKeyPair);
const keyPattern = /^dak_[0-9A-HJKMNP-TV-Z]{26}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');

function origin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw fail('invalid_app_data_origin');
  return url.origin;
}
function label(context) {
  if (!context || !/^dar_[0-9A-HJKMNP-TV-Z]{26}$/.test(context.request_id) || !keyPattern.test(context.key_id) ||
    !digestPattern.test(context.recipient_fingerprint) || !Number.isFinite(Date.parse(context.expires_at)) ||
    new Date(context.expires_at).toISOString() !== context.expires_at) throw fail('invalid_app_data_context');
  return Buffer.from(JSON.stringify(['bud-app-key-v1', context.request_id, context.key_id, context.recipient_fingerprint, context.expires_at]));
}
function contextOnly(value) {
  const context = { request_id: value.request_id, key_id: value.key_id,
    recipient_fingerprint: value.recipient_fingerprint, expires_at: value.expires_at };
  label(context);
  return context;
}
function proof(privateKey, action, context, ciphertextDigest) {
  const bytes = Buffer.concat([Buffer.from(`bud-app-key-proof-v1:${action}\n`), label(context),
    Buffer.from(action === 'installed' ? `\n${ciphertextDigest}` : '')]);
  return { signature: sign('sha256', bytes, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url') };
}

export class BudAppData {
  #appId; #origin; #directory; #fetch;
  constructor({ appId, apiOrigin, stateRoot = join(homedir(), '.local', 'share', 'bud', 'app-data'), fetch: transport = globalThis.fetch }) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(appId) || !isAbsolute(stateRoot)) throw fail('invalid_app_data_config');
    this.#appId = appId;
    this.#origin = origin(apiOrigin);
    this.#directory = join(stateRoot, appId);
    this.#fetch = transport;
  }

  async #directoryReady() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw fail('unsafe_app_data_directory');
  }
  async #read(name) {
    let file;
    try {
      file = await open(join(this.#directory, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16_384 ||
        (process.getuid && info.uid !== process.getuid())) throw fail('unsafe_app_data_file');
      return JSON.parse(await file.readFile('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fail('app_data_state_unavailable');
    } finally { await file?.close(); }
  }
  async #writeOnce(name, value) {
    const temporary = join(this.#directory, `.pending-${randomUUID()}`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close(); file = undefined;
      try { await link(temporary, join(this.#directory, name)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const directory = await open(this.#directory, fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw fail('app_data_state_write_failed'); }
    finally {
      await file?.close();
      await unlink(temporary).catch(() => {});
    }
    return this.#read(name);
  }
  async #identity() {
    await this.#directoryReady();
    let stored = await this.#read('installation.json');
    if (!stored) {
      const pair = await generate('rsa', { modulusLength: 3072 });
      stored = await this.#writeOnce('installation.json', { version: 1, app_id: this.#appId, api_origin: this.#origin,
        private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    }
    if (stored?.version !== 1 || stored.app_id !== this.#appId || stored.api_origin !== this.#origin) throw fail('app_data_identity_mismatch');
    try {
      const privateKey = createPrivateKey(stored.private_key);
      if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error();
      const publicKey = createPublicKey(privateKey);
      return { privateKey, public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        recipient_fingerprint: digest(publicKey.export({ type: 'spki', format: 'der' })) };
    } catch { throw fail('app_data_identity_unavailable'); }
  }
  async initialize() {
    const identity = await this.#identity();
    return { app_id: this.#appId, api_origin: this.#origin, public_key: identity.public_key,
      recipient_fingerprint: identity.recipient_fingerprint };
  }
  async #request(path, options = {}) {
    let response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(response.status === 404 ? 'app_data_setup_unavailable' : response.status === 403 ? 'app_data_permission_denied' : 'app_data_request_failed');
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) throw fail('app_data_response_too_large');
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (['app_data_setup_unavailable', 'app_data_permission_denied', 'app_data_request_failed', 'app_data_response_too_large'].includes(error.code)) throw error;
      throw fail('app_data_connection_failed');
    }
  }

  async install(value) {
    const context = contextOnly(value);
    const identity = await this.#identity();
    if (identity.recipient_fingerprint !== context.recipient_fingerprint) throw fail('app_data_recipient_mismatch');
    const filename = `${context.key_id}.json`;
    let stored = await this.#read(filename);
    if (!stored) {
      const delivered = await this.#request(`/api/app-data/setup/${context.key_id}/retrieve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof(identity.privateKey, 'retrieve', context)),
      });
      if (delivered.status !== 'handoff_pending') {
        if (delivered.status === 'installed') throw fail('app_data_local_credential_missing');
        if (!['revoked', 'setup_failed'].includes(delivered.status)) throw fail('invalid_app_data_delivery');
        return { status: delivered.status, key_id: context.key_id };
      }
      const envelope = delivered.envelope;
      let credential;
      try {
        if (envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256' ||
          !label(contextOnly(envelope)).equals(label(context)) || !/^[A-Za-z0-9_-]{512}$/.test(envelope.ciphertext)) throw new Error();
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
        if (digest(ciphertext) !== envelope.ciphertext_sha256) throw new Error();
        credential = privateDecrypt({ key: identity.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256', oaepLabel: label(context) }, ciphertext).toString();
        if (!new RegExp(`^${context.key_id}\\.[A-Za-z0-9_-]{43}$`).test(credential)) throw new Error();
      } catch { throw fail('invalid_app_data_delivery'); }
      stored = await this.#writeOnce(filename, { version: 1, context, credential, ciphertext_digest: envelope.ciphertext_sha256 });
    }
    if (stored?.version !== 1 || !label(stored.context).equals(label(context)) || !digestPattern.test(stored.ciphertext_digest) ||
      !new RegExp(`^${context.key_id}\\.[A-Za-z0-9_-]{43}$`).test(stored.credential)) throw fail('app_data_credential_mismatch');
    // Disk durability precedes this receipt. After a lost response, restart loads
    // the same credential/digest and retries acknowledgement without retrieval.
    const result = await this.#request(`/api/app-data/setup/${context.key_id}/installed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proof(identity.privateKey, 'installed', context, stored.ciphertext_digest)),
    });
    if (!['installed', 'revoked', 'setup_failed'].includes(result.status)) throw fail('invalid_app_data_receipt');
    return { status: result.status, key_id: context.key_id };
  }

  async query(keyId, resource, parameters = {}) {
    if (!keyPattern.test(keyId) || typeof resource !== 'string' ||
      !/^(contacts(?:\/[0-9A-HJKMNP-TV-Z]{26}(?:\/(?:history|location-context))?)?|location)$/.test(resource)) throw fail('invalid_app_data_query');
    await this.#identity(); // Pins the credential to the original API origin.
    const stored = await this.#read(`${keyId}.json`);
    if (!stored || stored.context?.key_id !== keyId || !new RegExp(`^${keyId}\\.[A-Za-z0-9_-]{43}$`).test(stored.credential)) throw fail('app_data_local_credential_missing');
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (!['search', 'visibility', 'limit', 'cursor', 'from', 'to'].includes(key) || !['string', 'number'].includes(typeof value)) throw fail('invalid_app_data_query');
      search.set(key, String(value));
    }
    return this.#request(`/api/app-data/${resource}${search.size ? `?${search}` : ''}`, {
      headers: { authorization: `Bearer ${stored.credential}` },
    });
  }
}
