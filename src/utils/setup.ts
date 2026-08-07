import { render } from 'ink';
import React from 'react';

import type { ShadowConfig } from './config.js';

import { loadConfig, saveConfig } from './config.js';

/**
 * Runs the interactive setup wizard using React/Ink if configuration is missing or forced via --reconfigure.
 * Returns the validated configuration object.
 */
export async function runSetupWizard(forceReconfigure = false): Promise<ShadowConfig> {
  // Check existing config unless reconfiguration is forced
  if (!forceReconfigure) {
    const existing = await loadConfig();
    if (existing) return existing;
  }

  // This is now handled by the Shell component in the main command
  // For backward compatibility, we'll create a minimal config request
  throw new Error('Setup wizard should be handled by Shell component');
}

/**
 * Returns a helpful placeholder for the model input based on the selected provider
 */
export function getModelPlaceholder(provider: string): string {
  switch (provider) {
    case 'anthropic': {
      return 'claude-sonnet-4-20250514';
    }

    case 'custom': {
      return 'your-model-name';
    }

    case 'google': {
      return 'gemini-2.5-pro-preview-05-06';
    }

    case 'mistral': {
      return 'mistral-large-latest';
    }

    case 'ollama': {
      return 'llama3';
    }

    case 'openai': {
      return 'gpt-4o';
    }

    default: {
      return 'model-name';
    }
  }
}
