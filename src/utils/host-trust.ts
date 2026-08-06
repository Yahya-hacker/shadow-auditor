import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {writeFileAtomic} from './fs-atomic.js';

const TRUST_DIRECTORY = path.join(os.homedir(), '.shadow-auditor', 'trust');

export function defaultTrustPath(fileName: string): string {
  return path.join(TRUST_DIRECTORY, fileName);
}

export async function loadOrCreateHostKey(keyPath: string): Promise<Buffer> {
  try {
    const stats = await fs.lstat(keyPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Host trust key is not a regular file: ${keyPath}`);
    }

    const key = Buffer.from((await fs.readFile(keyPath, 'utf8')).trim(), 'base64');
    if (key.length !== 32) throw new Error(`Host trust key has an invalid length: ${keyPath}`);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(keyPath), {mode: 0o700, recursive: true});
  const key = randomBytes(32);
  await writeFileAtomic(keyPath, `${key.toString('base64')}\n`);
  await fs.chmod(keyPath, 0o600);
  return key;
}

export function signHostData(key: Buffer, context: string, data: string): string {
  return createHmac('sha256', key)
    .update(context)
    .update('\0')
    .update(data)
    .digest('hex');
}

export function verifyHostData(
  key: Buffer,
  context: string,
  data: string,
  signature: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signHostData(key, context, data), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
