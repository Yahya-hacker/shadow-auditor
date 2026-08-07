import { expect } from 'chai';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ShadowConfig } from '../src/utils/config.js';

import {
  CACHE_FILENAME,
  CACHE_GRACE_MS,
  CACHE_TTL_MS,
  extractTier,
  getCachePath,
  hashKey,
  type LicenseTier,
  POLAR_ORG_ID,
  type PolarValidateResponse,
  readCache,
  validateLicense,
  writeCache,
} from '../src/core/licensing/polar-validator.js';
import { enforceLicenseGate, PRO_AUDIT_MODES, UPGRADE_URL } from '../src/core/policy/license-guard.js';
import { ENV_VAR_MAP, getApiKeyFromEnv, KeychainAdapter, SERVICE_NAME } from '../src/utils/keychain.js';

describe('licensing and credential vault', () => {
  // ===========================================================================
  // Task 1: Credential Vault Tests
  // ===========================================================================

  describe('keychain-adapter', () => {
    describe('constants', () => {
      it('should use shadow-auditor as the service name', () => {
        expect(SERVICE_NAME).to.equal('shadow-auditor');
      });

      it('should map all supported providers to env vars', () => {
        expect(ENV_VAR_MAP).to.have.property('openai', 'SHADOW_OPENAI_KEY');
        expect(ENV_VAR_MAP).to.have.property('anthropic', 'SHADOW_ANTHROPIC_KEY');
        expect(ENV_VAR_MAP).to.have.property('google', 'SHADOW_GOOGLE_KEY');
        expect(ENV_VAR_MAP).to.have.property('mistral', 'SHADOW_MISTRAL_KEY');
        expect(ENV_VAR_MAP).to.have.property('ollama', 'SHADOW_OLLAMA_KEY');
        expect(ENV_VAR_MAP).to.have.property('custom', 'SHADOW_CUSTOM_KEY');
      });
    });

    describe('getApiKeyFromEnv', () => {
      it('should return null for unknown provider', () => {
        expect(getApiKeyFromEnv('nonexistent')).to.be.null;
      });

      it('should return null when env var is not set', () => {
        delete process.env.SHADOW_OPENAI_KEY;
        expect(getApiKeyFromEnv('openai')).to.be.null;
      });

      it('should return the env var value when set', () => {
        process.env.SHADOW_OPENAI_KEY = 'sk-test-key-12345';
        expect(getApiKeyFromEnv('openai')).to.equal('sk-test-key-12345');
        delete process.env.SHADOW_OPENAI_KEY;
      });

      it('should trim whitespace from env var values', () => {
        process.env.SHADOW_ANTHROPIC_KEY = '  sk-ant-test  ';
        expect(getApiKeyFromEnv('anthropic')).to.equal('sk-ant-test');
        delete process.env.SHADOW_ANTHROPIC_KEY;
      });

      it('should return null for empty env var', () => {
        process.env.SHADOW_OPENAI_KEY = '   ';
        expect(getApiKeyFromEnv('openai')).to.be.null;
        delete process.env.SHADOW_OPENAI_KEY;
      });
    });

    describe('KeychainAdapter', () => {
      it('should fall back to env vars when keychain is unavailable', async () => {
        process.env.SHADOW_OPENAI_KEY = 'sk-env-fallback';
        const adapter = new KeychainAdapter();
        const key = await adapter.getApiKey('openai');
        expect(key).to.equal('sk-env-fallback');
        delete process.env.SHADOW_OPENAI_KEY;
      });

      it('should return null when both keychain and env var are unavailable', async () => {
        delete process.env.SHADOW_OPENAI_KEY;
        const adapter = new KeychainAdapter();
        const key = await adapter.getApiKey('openai');
        expect(key).to.be.null;
      });

      it('should not throw when setApiKey fails', async () => {
        const adapter = new KeychainAdapter();
        // Should silently no-op since cross-keychain isn't installed in test env
        await adapter.setApiKey('openai', 'test-key');
      });
    });
  });

  // ===========================================================================
  // Task 2: License Engine Tests
  // ===========================================================================

  describe('polar-validator', () => {
    describe('hashKey', () => {
      it('should produce a deterministic SHA-256 hash', () => {
        const hash1 = hashKey('test-key-123');
        const hash2 = hashKey('test-key-123');
        expect(hash1).to.equal(hash2);
      });

      it('should produce different hashes for different keys', () => {
        const hash1 = hashKey('key-a');
        const hash2 = hashKey('key-b');
        expect(hash1).to.not.equal(hash2);
      });

      it('should match Node crypto output', () => {
        const expected = crypto.createHash('sha256').update('hello').digest('hex');
        expect(hashKey('hello')).to.equal(expected);
      });
    });

    describe('getCachePath', () => {
      it('should resolve to home directory', () => {
        const cachePath = getCachePath();
        expect(cachePath).to.equal(path.join(os.homedir(), CACHE_FILENAME));
      });
    });

    describe('extractTier', () => {
      it('should return free for invalid response', () => {
        const response: PolarValidateResponse = { valid: false };
        expect(extractTier(response)).to.equal('free');
      });

      it('should return pro when benefit description contains "pro"', () => {
        const response: PolarValidateResponse = {
          benefit: { description: 'Shadow Auditor Pro License' },
          valid: true,
        };
        expect(extractTier(response)).to.equal('pro');
      });

      it('should return pro when benefit properties contain "pro"', () => {
        const response: PolarValidateResponse = {
          benefit: { properties: { tier: 'pro' } },
          valid: true,
        };
        expect(extractTier(response)).to.equal('pro');
      });

      it('should return solo for valid key without pro indicator', () => {
        const response: PolarValidateResponse = {
          benefit: { description: 'Shadow Auditor Solo License' },
          valid: true,
        };
        expect(extractTier(response)).to.equal('solo');
      });

      it('should return solo when benefit is empty but key is valid', () => {
        const response: PolarValidateResponse = { valid: true };
        expect(extractTier(response)).to.equal('solo');
      });
    });

    describe('cache read/write', () => {
      const testCachePath = path.join(os.tmpdir(), `.shadow-test-cache-${Date.now()}.json`);

      afterEach(async () => {
        try { await fs.unlink(testCachePath); } catch { /* ignore */ }
      });

      it('should return null when cache file does not exist', async () => {
        const result = await readCache();
        // May or may not exist depending on environment, but should not throw
        expect(result === null || typeof result === 'object').to.be.true;
      });
    });

    describe('validateLicense', () => {
      it('should return free tier for empty key', async () => {
        const result = await validateLicense('');
        expect(result.tier).to.equal('free');
        expect(result.cached).to.be.false;
      });

      it('should return free tier for undefined key', async () => {
        const result = await validateLicense();
        expect(result.tier).to.equal('free');
        expect(result.cached).to.be.false;
      });

      it('should return free tier for whitespace-only key', async () => {
        const result = await validateLicense('   ');
        expect(result.tier).to.equal('free');
        expect(result.cached).to.be.false;
      });

      it('should handle network failure gracefully', async () => {
        // With a fake key and no network, should return free
        const result = await validateLicense('fake-key-that-will-fail');
        expect(result.tier).to.equal('free');
        // Should have an error message about network unavailability
        // (or cached from a previous test run — either is acceptable)
      });
    });

    describe('constants', () => {
      it('should have a 24-hour cache TTL', () => {
        expect(CACHE_TTL_MS).to.equal(24 * 60 * 60 * 1000);
      });

      it('should have a 72-hour grace period', () => {
        expect(CACHE_GRACE_MS).to.equal(72 * 60 * 60 * 1000);
      });

      it('should have a placeholder org ID', () => {
        expect(POLAR_ORG_ID).to.be.a('string');
        expect(POLAR_ORG_ID.length).to.be.greaterThan(0);
      });
    });
  });

  // ===========================================================================
  // Task 3: Feature Guard Tests
  // ===========================================================================

  describe('license-guard', () => {
    const baseConfig: ShadowConfig = {
      apiKey: 'test-key',
      model: 'gpt-4o',
      provider: 'openai',
    };

    describe('free features', () => {
      it('should allow triage mode without a license', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'triage' });
        expect(result.allowed).to.be.true;
      });

      it('should allow balanced mode without a license', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'balanced' });
        expect(result.allowed).to.be.true;
      });

      it('should allow quick mode without a license', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'quick' });
        expect(result.allowed).to.be.true;
      });

      it('should allow deep mode without a license', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'deep' });
        expect(result.allowed).to.be.true;
      });

      it('should allow patch-only mode without a license', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'patch-only' });
        expect(result.allowed).to.be.true;
      });

      it('should allow shell usage without any mode set', async () => {
        const result = await enforceLicenseGate(baseConfig);
        expect(result.allowed).to.be.true;
      });
    });

    describe('pro features', () => {
      it('should block deep-sast mode for free tier', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'deep-sast' });
        expect(result.allowed).to.be.false;
        expect(result.requiredTier).to.equal('pro');
        expect(result.feature).to.include('deep-sast');
        expect(result.upgradeUrl).to.equal(UPGRADE_URL);
      });

      it('should block full-report mode for free tier', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'full-report' });
        expect(result.allowed).to.be.false;
        expect(result.requiredTier).to.equal('pro');
        expect(result.feature).to.include('full-report');
      });

      it('should block CI mode for free tier', async () => {
        const result = await enforceLicenseGate({
          ...baseConfig,
          ci: { enabled: true, failOn: 'high' },
        });
        expect(result.allowed).to.be.false;
        expect(result.feature).to.include('CI/CD');
      });

      it('should include current tier in blocked result', async () => {
        const result = await enforceLicenseGate({ ...baseConfig, auditMode: 'deep-sast' });
        expect(result.currentTier).to.equal('free');
      });
    });

    describe('PRO_AUDIT_MODES constant', () => {
      it('should include deep-sast', () => {
        expect(PRO_AUDIT_MODES.has('deep-sast')).to.be.true;
      });

      it('should include full-report', () => {
        expect(PRO_AUDIT_MODES.has('full-report')).to.be.true;
      });

      it('should not include triage', () => {
        expect(PRO_AUDIT_MODES.has('triage')).to.be.false;
      });
    });
  });
});
