import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadConfig,
  registerSecretStoreAdapter,
  saveConfig,
  validateConfig,
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

  it('persists validated per-agent tool policy and autonomy budgets', async () => {
    await saveConfig({
      apiKey: '',
      model: 'qwen3',
      provider: 'ollama',
      toolPolicy: {
        agents: {
          sast_audit: {
            disabledTools: ['execute_command'],
            enabledTools: ['context_retrieval', 'read_file_content'],
            maxToolSteps: 512,
          },
        },
        disabledTools: ['sandbox_exec'],
      },
    });

    expect(await loadConfig()).to.deep.include({
      toolPolicy: {
        agents: {
          sast_audit: {
            disabledTools: ['execute_command'],
            enabledTools: ['context_retrieval', 'read_file_content'],
            maxToolSteps: 512,
          },
        },
        disabledTools: ['sandbox_exec'],
      },
    });
  });

  it('bounds report handoff repair attempts', () => {
    const base = {apiKey: '', model: 'qwen3', provider: 'ollama'};
    expect(validateConfig({...base, reportValidation: {maxRepairRetries: -1}})).to.equal(null);
    expect(validateConfig({...base, reportValidation: {maxRepairRetries: 5}})).to.equal(null);
    expect(validateConfig({...base, reportValidation: {maxRepairRetries: 4}}))
      .to.deep.include({reportValidation: {maxRepairRetries: 4}});
  });
});
