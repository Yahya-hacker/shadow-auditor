import type { ShadowConfig } from './config.js';

import { loadConfig } from './config.js';

/**
 * Runs the interactive setup wizard.
 * The actual UI flow is handled by BootScreen -> SetupScreen in the Ink app.
 * This function is primarily for CI/headless environments or checking existing config.
 */
export async function runSetupWizard(forceReconfigure = false): Promise<ShadowConfig> {
  if (!forceReconfigure) {
    const existing = await loadConfig();
    if (existing) return existing;
  }

  throw new Error('Setup wizard should be handled by Shell component UI flow.');
}

export function getModelPlaceholder(provider: string): string {
  switch (provider) {
    case 'anthropic': { return 'claude-sonnet-4-20250514';
    }

    case 'custom': { return 'your-model-name';
    }

    case 'deepseek': { return 'deepseek-chat';
    }

    case 'google': { return 'gemini-2.5-pro-preview-05-06';
    }

    case 'mistral': { return 'mistral-large-latest';
    }

    case 'moonshot': { return 'moonshot-v1-8k';
    }

    case 'nvidia': { return 'meta/llama-3.1-70b-instruct';
    }

    case 'ollama': { return 'llama3';
    }

    case 'openai': { return 'gpt-4o';
    }

    case 'perplexity': { return 'sonar-pro';
    }

    case 'qwen': { return 'qwen-plus';
    }

    default: { return 'model-name';
    }
  }
}
