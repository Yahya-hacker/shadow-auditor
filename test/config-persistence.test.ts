import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadConfig,
  registerSecretStoreAdapter,
  saveConfig,
} from '../src/utils/config.js';

describe('configuration persistence', () => {
  let originalHome: string | undefined;
  let tempPath: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-config-'));
    process.env.HOME = tempPath;
  });

  afterEach(async () => {
    registerSecretStoreAdapter(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempPath, {force: true, recursive: true});
  });

  it('restores an optional custom-provider API key from the keychain', async () => {
    const secrets = new Map<string, string>();
    registerSecretStoreAdapter({
      async getApiKey(provider) {
        return secrets.get(provider) ?? null;
      },
      async setApiKey(provider, apiKey) {
        secrets.set(provider, apiKey);
      },
    });

    await saveConfig({
      apiKey: 'custom-secret',
      customBaseUrl: 'https://models.example.test/v1',
      model: 'custom-model',
      provider: 'custom',
    });
    const persisted = await fs.readFile(
      path.join(tempPath, '.shadow-auditor.json'),
      'utf8',
    );
    expect(persisted).not.to.include('custom-secret');

    expect(await loadConfig()).to.deep.include({
      apiKey: 'custom-secret',
      customBaseUrl: 'https://models.example.test/v1',
      model: 'custom-model',
      provider: 'custom',
    });
  });
});
