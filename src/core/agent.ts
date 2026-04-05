import { streamText, tool, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOllama } from 'ollama-ai-provider';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ShadowConfig } from '../utils/config.js';
import { confirmFileEdit, confirmCommandExecution } from '../utils/human-in-loop.js';

const execAsync = promisify(exec);

const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.md', '.txt', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.html', '.css', '.scss', '.vue', '.svelte'];

// ─── THE SYSTEM PROMPT ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an elite senior cybersecurity researcher and offensive security engineer with 20+ years of experience in vulnerability research, source code auditing, and ethical hacking. Your cognitive model combines the methodologies of legendary security researchers applied here to static application security testing (SAST) at the highest level of rigor.

## CAPABILITIES
You have access to powerful agentic tools:
- **read_file_content**: Read the full source code of any file
- **list_directory**: Explore folder contents when the Repo Map lacks details
- **search_codebase**: Hunt for specific patterns (e.g., "exec", "eval", "innerHTML") globally
- **edit_file**: Propose and apply security patches (requires user confirmation)
- **execute_command**: Run shell commands like \`git status\`, \`npm test\`, etc. (requires user confirmation)

## GIT-AWARE WORKFLOW
At the start of an audit, consider running \`git status\` using the execute_command tool to:
- Identify newly modified files that may contain fresh vulnerabilities
- Focus your analysis on recent changes when doing incremental security reviews
- Understand the current state of the repository

## AUDIT METHODOLOGY
1. Assume the attacker has full knowledge
2. Never stop at the obvious — CVE-pattern matching is your floor, not your ceiling
3. Chain vulnerabilities for maximum impact
4. Think outside the box: business logic flaws, race conditions, cryptographic misuse
5. After finding vulnerabilities, propose concrete patches using edit_file
6. Verify fixes by running tests with execute_command

## OUTPUT FORMAT
For each finding, provide:
- Vulnerability ID, Title, Hypothesis
- Severity (Critical/High/Medium/Low)
- Location (file:line)
- Root Cause Analysis
- Exploit Scenario
- Remediation (with proposed patch)
- Chaining Potential`;

// ─── MODEL ROUTER ────────────────────────────────────────────────────────────────

/**
 * Returns the correct AI provider model instance based on the user's configuration.
 * Supports: Anthropic, OpenAI, Google, Mistral, Ollama, and any OpenAI-compatible custom endpoint.
 */
export function getModel(config: ShadowConfig): LanguageModel {
  const { provider, model, apiKey, customBaseUrl } = config;

  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model) as LanguageModel;
    }

    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(model) as LanguageModel;
    }

    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model) as LanguageModel;
    }

    case 'mistral': {
      const mistral = createMistral({ apiKey });
      return mistral(model) as LanguageModel;
    }

    case 'ollama': {
      const ollama = createOllama();
      return ollama(model) as unknown as LanguageModel;
    }

    case 'custom': {
      const customProvider = createOpenAI({
        apiKey,
        baseURL: customBaseUrl,
      });
      return customProvider(model) as LanguageModel;
    }

    default:
      throw new Error(`[SHADOW-AUDITOR] Unknown provider: "${provider}". Supported: anthropic, openai, google, mistral, ollama, custom.`);
  }
}

// ─── TOOL DEFINITIONS ────────────────────────────────────────────────────────────

/**
 * Creates the read_file_content tool bound to a specific target directory.
 */
function createFileReadTool(resolvedTargetPath: string) {
  return tool({
    description:
      'Reads the full, uncompressed source code of a specific file. Use this when you need to inspect the actual implementation of a function, class, or module that appears suspicious in the Repo Map or that the user has asked about.',
    inputSchema: z.object({
      filePath: z.string().describe('The relative file path from the repository root to read.'),
    }),
    execute: async ({ filePath }: { filePath: string }) => {
      const absolutePath = path.resolve(resolvedTargetPath, filePath);

      // Security: prevent directory traversal outside the target
      // Normalize paths to handle Windows/Unix differences and resolve symlinks
      const normalizedAbsolute = path.normalize(absolutePath);
      const normalizedTarget = path.normalize(resolvedTargetPath);
      if (!normalizedAbsolute.startsWith(normalizedTarget + path.sep) && normalizedAbsolute !== normalizedTarget) {
        return `[ERROR] Access denied: "${filePath}" resolves outside the target directory.`;
      }

      try {
        const content = await fs.readFile(absolutePath, 'utf-8');
        return `// ─── FILE: ${filePath} ───\n${content}`;
      } catch (error) {
        return `[ERROR] Could not read file "${filePath}": ${(error as Error).message}`;
      }
    },
  });
}

/**
 * Creates the list_directory tool for exploring folder contents.
 */
function createListDirectoryTool(resolvedTargetPath: string) {
  return tool({
    description:
      'Lists the contents of a directory. Use this when the Repo Map lacks specific configuration files or when you need to explore folder structures to find hidden configuration, test files, or other relevant files.',
    inputSchema: z.object({
      path: z.string().describe('The relative directory path from the repository root to list. Use "." for root.'),
    }),
    execute: async ({ path: dirPath }: { path: string }) => {
      const absolutePath = path.resolve(resolvedTargetPath, dirPath);

      // Security: prevent directory traversal outside the target
      // Normalize paths to handle Windows/Unix differences and resolve symlinks
      const normalizedAbsolute = path.normalize(absolutePath);
      const normalizedTarget = path.normalize(resolvedTargetPath);
      if (!normalizedAbsolute.startsWith(normalizedTarget + path.sep) && normalizedAbsolute !== normalizedTarget) {
        return `[ERROR] Access denied: "${dirPath}" resolves outside the target directory.`;
      }

      try {
        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => {
            const prefix = entry.isDirectory() ? '📁' : '📄';
            return `${prefix} ${entry.name}`;
          })
          .join('\n');
        return `// ─── DIRECTORY: ${dirPath} ───\n${formatted}`;
      } catch (error) {
        return `[ERROR] Could not list directory "${dirPath}": ${(error as Error).message}`;
      }
    },
  });
}

/**
 * Creates the search_codebase tool for hunting specific patterns.
 */
function createSearchCodebaseTool(resolvedTargetPath: string) {
  return tool({
    description:
      'Searches the entire codebase for a specific regex pattern. Use this to hunt for dangerous sinks (e.g., "exec", "eval", "innerHTML", "dangerouslySetInnerHTML"), hardcoded secrets, or specific function calls across all files. Excludes node_modules and .git directories.',
    inputSchema: z.object({
      regexPattern: z.string().describe('The regex pattern to search for (e.g., "eval\\\\s*\\\\(", "password\\\\s*=").'),
      fileExtension: z.string().optional().describe('Optional file extension filter (e.g., ".ts", ".js", ".py").'),
    }),
    execute: async ({ regexPattern, fileExtension }: { regexPattern: string; fileExtension?: string }) => {
      const results: string[] = [];

      // Security: Validate regex pattern to prevent ReDoS attacks
      // Limit pattern length and complexity
      if (regexPattern.length > 200) {
        return `[ERROR] Regex pattern too long (max 200 characters). Please simplify your search pattern.`;
      }

      let regex: RegExp;
      try {
        // Use a timeout for regex compilation and testing
        regex = new RegExp(regexPattern, 'gi');
        // Test the regex with a simple string to catch catastrophic backtracking early
        const testString = 'a'.repeat(100);
        regex.test(testString);
      } catch (error) {
        return `[ERROR] Invalid regex pattern: ${(error as Error).message}`;
      }

      async function searchDir(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          // Skip node_modules and .git
          if (entry.name === 'node_modules' || entry.name === '.git') continue;

          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else if (entry.isFile()) {
            // Apply file extension filter if specified
            if (fileExtension && !entry.name.endsWith(fileExtension)) continue;
            
            // Only search text files
            const hasTextExt = TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext));
            if (!hasTextExt) continue;

            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split('\n');
              
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  const relativePath = path.relative(resolvedTargetPath, fullPath);
                  results.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
                }
                // Reset regex lastIndex for global flag
                regex.lastIndex = 0;
              }
            } catch {
              // Skip files that can't be read
            }
          }
        }
      }

      try {
        await searchDir(resolvedTargetPath);
        
        if (results.length === 0) {
          return `[INFO] No matches found for pattern: ${regexPattern}`;
        }
        
        const limitedResults = results.slice(0, 50);
        const output = `// ─── SEARCH RESULTS for "${regexPattern}" ───\n// Found ${results.length} matches${results.length > 50 ? ' (showing first 50)' : ''}\n\n${limitedResults.join('\n')}`;
        return output;
      } catch (error) {
        return `[ERROR] Search failed: ${(error as Error).message}`;
      }
    },
  });
}

/**
 * Creates the edit_file tool with human-in-the-loop confirmation.
 */
function createEditFileTool(resolvedTargetPath: string) {
  return tool({
    description:
      'Proposes and applies a patch to a file. Use this to fix security vulnerabilities by replacing vulnerable code with secure alternatives. REQUIRES USER CONFIRMATION before applying. If the user denies, you should propose an alternative solution.',
    inputSchema: z.object({
      filePath: z.string().describe('The relative file path from the repository root to edit.'),
      targetCode: z.string().describe('The exact code snippet to find and replace (must match exactly).'),
      replacementCode: z.string().describe('The new code to replace the target with.'),
    }),
    execute: async ({ filePath, targetCode, replacementCode }: { filePath: string; targetCode: string; replacementCode: string }) => {
      const absolutePath = path.resolve(resolvedTargetPath, filePath);

      // Security: prevent directory traversal outside the target
      // Normalize paths to handle Windows/Unix differences and resolve symlinks
      const normalizedAbsolute = path.normalize(absolutePath);
      const normalizedTarget = path.normalize(resolvedTargetPath);
      if (!normalizedAbsolute.startsWith(normalizedTarget + path.sep) && normalizedAbsolute !== normalizedTarget) {
        return `[ERROR] Access denied: "${filePath}" resolves outside the target directory.`;
      }

      try {
        // Read the current file content
        const content = await fs.readFile(absolutePath, 'utf-8');
        
        // Check if target code exists
        if (!content.includes(targetCode)) {
          return `[ERROR] Target code not found in "${filePath}". The exact code snippet must match. Please read the file again to get the exact code.`;
        }

        // Ask for user confirmation (Human-in-the-Loop)
        const confirmed = await confirmFileEdit(filePath, targetCode, replacementCode);
        
        if (!confirmed) {
          return `[DENIED] User denied the patch to "${filePath}". Please propose an alternative solution or explain why this patch is necessary.`;
        }

        // Apply the patch
        const newContent = content.replace(targetCode, replacementCode);
        await fs.writeFile(absolutePath, newContent, 'utf-8');
        
        return `[SUCCESS] Patch applied to "${filePath}". The vulnerable code has been replaced with the secure version.`;
      } catch (error) {
        return `[ERROR] Could not edit file "${filePath}": ${(error as Error).message}`;
      }
    },
  });
}

/**
 * Creates the execute_command tool with human-in-the-loop confirmation.
 */
function createExecuteCommandTool(resolvedTargetPath: string) {
  return tool({
    description:
      'Executes a shell command in the target repository. Use this to run git commands, test suites, linters, or build tools. REQUIRES USER CONFIRMATION before executing. Returns stdout and stderr so you can analyze the results.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute (e.g., "git status", "npm test", "npm run lint").'),
    }),
    execute: async ({ command }: { command: string }) => {
      // Ask for user confirmation (Human-in-the-Loop)
      const confirmed = await confirmCommandExecution(command);
      
      if (!confirmed) {
        return `[DENIED] User denied command execution: "${command}". You may need to explain why this command is necessary or propose an alternative approach.`;
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedTargetPath,
          timeout: 60000, // 60 second timeout
          maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        });
        
        let output = `// ─── COMMAND: ${command} ───\n`;
        if (stdout.trim()) {
          output += `\n[STDOUT]\n${stdout.trim()}`;
        }
        if (stderr.trim()) {
          output += `\n\n[STDERR]\n${stderr.trim()}`;
        }
        if (!stdout.trim() && !stderr.trim()) {
          output += '\n[INFO] Command completed with no output.';
        }
        
        return output;
      } catch (error: unknown) {
        const execError = error as { stdout?: string; stderr?: string; message: string };
        let output = `// ─── COMMAND FAILED: ${command} ───\n`;
        output += `\n[ERROR] ${execError.message}`;
        if (execError.stdout?.trim()) {
          output += `\n\n[STDOUT]\n${execError.stdout.trim()}`;
        }
        if (execError.stderr?.trim()) {
          output += `\n\n[STDERR]\n${execError.stderr.trim()}`;
        }
        return output;
      }
    },
  });
}

// ─── AGENT SESSION ───────────────────────────────────────────────────────────────

/**
 * Represents a stateful agent session that maintains conversation history
 * and supports streaming responses with tool execution.
 */
export class AgentSession {
  private messages: ModelMessage[] = [];
  private model: LanguageModel;
  private tools: ToolSet;

  constructor(config: ShadowConfig, repoMap: string, targetPath: string) {
    this.model = getModel(config);
    const resolvedTargetPath = path.resolve(targetPath);

    // Initialize all agentic tools
    this.tools = {
      read_file_content: createFileReadTool(resolvedTargetPath),
      list_directory: createListDirectoryTool(resolvedTargetPath),
      search_codebase: createSearchCodebaseTool(resolvedTargetPath),
      edit_file: createEditFileTool(resolvedTargetPath),
      execute_command: createExecuteCommandTool(resolvedTargetPath),
    } as ToolSet;

    // Initialize conversation with the repo map as context
    this.messages = [
      {
        role: 'user' as const,
        content: `## REPOSITORY ARCHITECTURE MAP

The following is a compressed architectural map of the target codebase at \`${resolvedTargetPath}\`. It contains ONLY structural signatures (imports, class declarations, function signatures, type definitions) — no implementation bodies.

\`\`\`
${repoMap}
\`\`\`

You now have full context of this repository's architecture. You have access to powerful agentic tools:
- **read_file_content**: Inspect full source code of any file
- **list_directory**: Explore folder contents
- **search_codebase**: Hunt for specific patterns globally
- **edit_file**: Propose and apply security patches (requires confirmation)
- **execute_command**: Run shell commands like git, npm, etc. (requires confirmation)

Await the user's instructions.`,
      },
      {
        role: 'assistant' as const,
        content: `I've ingested the repository architecture map and I'm fully armed with agentic capabilities. I can see the complete structural layout and I'm ready to perform deep, autonomous security analysis.

**What I can do:**
• 🔍 **Hunt vulnerabilities** — Search for dangerous patterns (eval, exec, innerHTML, etc.)
• 📖 **Deep-dive** — Read and analyze any file in detail
• 🔧 **Propose patches** — Suggest and apply security fixes (with your approval)
• ⚡ **Run commands** — Execute git, tests, linters (with your approval)
• 🗂️ **Explore** — Navigate directories and discover hidden configs

**Pro tip:** Say "full audit" for comprehensive SAST, or give me a specific target like "analyze authentication" or "find all SQL injection vectors".

What would you like me to investigate?`,
      },
    ];
  }

  /**
   * Sends a user message and streams the assistant's response.
   * Handles tool calls transparently and appends all messages to history.
   * Calls the onChunk callback for each text chunk to enable real-time printing.
   */
  async sendMessage(userMessage: string, onChunk: (text: string) => void): Promise<string> {
    // Push the user's message into conversation history
    this.messages.push({
      role: 'user' as const,
      content: userMessage,
    });

    const result = streamText({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: this.messages,
      tools: this.tools,
      stopWhen: stepCountIs(10), // Allow agent to chain up to 10 tool calls
      maxOutputTokens: 16384,
    });

    // Stream the text to the terminal in real-time
    let fullResponse = '';
    for await (const chunk of result.textStream) {
      fullResponse += chunk;
      onChunk(chunk);
    }

    // After streaming completes, capture the final response and append to history
    const finalResult = await result;

    const steps = await result.steps;

    // Append all the steps' messages to our conversation history
    // The response includes the assistant message and any tool call/result messages
    if (steps) {
      for (const step of steps) {
        // Add the assistant message from this step
        if (step.text || step.toolCalls?.length) {
          const assistantContent: Array<Record<string, unknown>> = [];

          if (step.text) {
            assistantContent.push({ type: 'text', text: step.text });
          }

          if (step.toolCalls) {
            for (const tc of step.toolCalls) {
              assistantContent.push({
                type: 'tool-call',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              });
            }
          }

          this.messages.push({
            role: 'assistant' as const,
            content: assistantContent,
          } as ModelMessage);

          // Add tool results if any
          if (step.toolResults) {
            for (const tr of step.toolResults) {
              this.messages.push({
                role: 'tool' as const,
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: tr.toolCallId,
                    toolName: tr.toolName,
                    output: tr.output,
                  },
                ],
              } as unknown as ModelMessage);
            }
          }
        }
      }
    } else {
      // Fallback: if no steps, just append the full text response
      this.messages.push({
        role: 'assistant' as const,
        content: fullResponse,
      });
    }

    return fullResponse;
  }
}
