import {AIMessage, AIMessageChunk} from '@langchain/core/messages';
import {expect} from 'chai';
import {z} from 'zod';

import {wrapTool} from '../src/core/graph/tools/langchain-wrapper.js';
import {
  bindToolsForProvider,
  sanitizeGoogleToolSchema,
} from '../src/core/providers/tool-binding.js';
import {executeLangChainToolLoop} from '../src/core/services/langchain-tool-executor.js';
import {createStagedReportFindingTool} from '../src/core/tools/report-finding.js';

describe('executeLangChainToolLoop', () => {
  it('reports provider usage from streamed swarm worker responses', async () => {
    const activities: Array<{kind: string; usage?: unknown}> = [];
    const model = {
      bindTools() {
        return {
          async *stream() {
            yield new AIMessageChunk({
              content: 'Done.',
              usage_metadata: {
                input_tokens: 21,
                output_tokens: 4,
                total_tokens: 25,
              },
            });
          },
        };
      },
      async invoke() {
        return new AIMessage('Completed from collected evidence.');
      },
    };

    await executeLangChainToolLoop({
      maxToolSteps: 1,
      model: model as never,
      onActivity: (activity) => activities.push(activity),
      prompt: 'Analyze the target.',
      systemPrompt: 'You are a security worker.',
      tools: {},
    });

    expect(activities.filter((activity) => activity.kind === 'token_usage')).to.deep.equal([
      {
        kind: 'token_usage',
        summary: 'Model usage recorded.',
        usage: {completion: 4, prompt: 21, total: 25},
      },
    ]);
  });

  it('does not expose an incomplete DeepSeek protocol prefix as worker progress', async () => {
    const activities: string[] = [];
    const model = {
      bindTools() {
        return {
          async *stream() {
            yield new AIMessageChunk({content: 'Public progress.\n<｜｜DS'});
          },
        };
      },
    };

    await executeLangChainToolLoop({
      maxToolSteps: 1,
      model: model as never,
      onActivity: (activity) => activities.push(activity.summary),
      prompt: 'Analyze the target.',
      providerHint: 'deepseek',
      systemPrompt: 'You are a security worker.',
      tools: {},
    });

    expect(activities).to.include('Public progress.');
    expect(activities.join(' ')).not.to.include('<｜｜DS');
  });

  it('counts a parallel tool-call batch as one model/tool iteration', async () => {
    let executions = 0;
    const model = {
      bindTools() {
        return {
          async *stream() {
            yield new AIMessageChunk({
              content: '',
              tool_calls: [
                {args: {value: 'one'}, id: 'call-1', name: 'record', type: 'tool_call'},
                {args: {value: 'two'}, id: 'call-2', name: 'record', type: 'tool_call'},
              ],
            });
          },
        };
      },
      async invoke() {
        return new AIMessage('Completed from collected evidence.');
      },
    };
    const result = await executeLangChainToolLoop({
      maxToolSteps: 1,
      model: model as never,
      prompt: 'Analyze the target.',
      systemPrompt: 'You are a security worker.',
      tools: {
        record: {
          description: 'Record a value.',
          async execute() {
            executions++;
            return 'recorded';
          },
          inputSchema: z.object({value: z.string()}),
        },
      },
    });

    expect(result.toolCalls).to.have.length(2);
    expect(executions).to.equal(2);
  });

  it('removes Gemini-incompatible exclusive bounds at every schema depth', () => {
    expect(sanitizeGoogleToolSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        count: {exclusiveMinimum: 0, type: 'number'},
        nested: {
          items: {exclusiveMaximum: 10, type: 'integer'},
          type: 'array',
        },
      },
      type: 'object',
    })).to.deep.equal({
      properties: {
        count: {minimum: 0, type: 'number'},
        nested: {
          items: {maximum: 10, type: 'integer'},
          type: 'array',
        },
      },
      type: 'object',
    });
  });

  it('inlines local JSON Schema references rejected by Gemini declarations', () => {
    expect(sanitizeGoogleToolSchema({
      properties: {
        locations: {
          items: {$ref: '#/properties/shared'},
          type: 'array',
        },
        shared: {
          properties: {line: {exclusiveMinimum: 0, type: 'integer'}},
          type: 'object',
        },
      },
      type: 'object',
    })).to.deep.equal({
      properties: {
        locations: {
          items: {
            properties: {line: {minimum: 0, type: 'integer'}},
            type: 'object',
          },
          type: 'array',
        },
        shared: {
          properties: {line: {minimum: 0, type: 'integer'}},
          type: 'object',
        },
      },
      type: 'object',
    });
  });

  it('binds the full reporting declaration without Gemini-incompatible keywords', () => {
    let declarations: unknown[] = [];
    const model = {
      bindTools(tools: unknown[]) {
        declarations = tools;
        return this;
      },
    };
    const reportFinding = wrapTool(
      createStagedReportFindingTool(),
      'report_finding',
      {providerHint: 'google'},
    );
    bindToolsForProvider(model as never, [reportFinding], 'google');
    const serialized = JSON.stringify(declarations);
    expect(serialized).not.to.include('"$ref"');
    expect(serialized).not.to.include('exclusiveMinimum');
    expect(serialized).to.include('"locations"');
    expect(serialized).to.include('"startLine"');
  });

  it('rejects unresolved and recursive Gemini schema references before API calls', () => {
    expect(() => sanitizeGoogleToolSchema({
      properties: {value: {$ref: '#/missing'}},
      type: 'object',
    })).to.throw('unresolved reference');
    expect(() => sanitizeGoogleToolSchema({
      properties: {node: {$ref: '#/properties/node'}},
      type: 'object',
    })).to.throw('recursive reference');
  });

  it('binds sanitized declarations for Gemini while preserving executable tools', () => {
    let declarations: unknown[] = [];
    const model = {
      bindTools(tools: unknown[]) {
        declarations = tools;
        return this;
      },
    };
    const executable = {
      description: 'Read lines.',
      name: 'read_file_content',
      schema: z.object({startLine: z.number().positive()}),
    };
    bindToolsForProvider(model as never, [executable as never], 'google');
    expect(JSON.stringify(declarations)).not.to.include('exclusiveMinimum');
    expect(executable.schema.safeParse({startLine: 0}).success).to.equal(false);
  });

  it('runs independent read-only tool calls concurrently and records model order', async () => {
    let streamCount = 0;
    let active = 0;
    let maxActive = 0;
    const model = {
      bindTools() {
        return {
          async *stream() {
            streamCount++;
            if (streamCount === 1) {
              yield new AIMessageChunk({
                content: '',
                tool_calls: [
                  {args: {filePath: 'slow'}, id: 'read-1', name: 'read_file_content', type: 'tool_call'},
                  {args: {filePath: 'fast'}, id: 'read-2', name: 'read_file_content', type: 'tool_call'},
                ],
              });
            } else {
              yield new AIMessageChunk({content: 'Done.'});
            }
          },
        };
      },
    };
    const result = await executeLangChainToolLoop({
      maxToolSteps: 4,
      model: model as never,
      prompt: 'Read both.',
      systemPrompt: 'Use tools.',
      tools: {
        read_file_content: {
          description: 'Read a file.',
          async execute({filePath}: {filePath: string}) {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => {
              setTimeout(resolve, filePath === 'slow' ? 25 : 5);
            });
            active--;
            return filePath;
          },
          inputSchema: z.object({filePath: z.string()}),
        },
      },
    });

    expect(maxActive).to.equal(2);
    expect(result.toolCalls.map((call) => call.args)).to.deep.equal([
      {filePath: 'slow'},
      {filePath: 'fast'},
    ]);
  });

  it('limits read-only worker batches to the configured concurrency ceiling', async () => {
    let streamCount = 0;
    let active = 0;
    let maxActive = 0;
    const model = {
      bindTools() {
        return {
          async *stream() {
            streamCount++;
            yield streamCount === 1
              ? new AIMessageChunk({
                content: '',
                tool_calls: Array.from({length: 6}, (_, index) => ({
                  args: {filePath: `src/${index}.ts`},
                  id: `read-${index}`,
                  name: 'read_file_content',
                  type: 'tool_call' as const,
                })),
              })
              : new AIMessageChunk({content: 'Done.'});
          },
        };
      },
    };

    await executeLangChainToolLoop({
      maxToolSteps: 8,
      model: model as never,
      prompt: 'Read all files.',
      systemPrompt: 'Use tools.',
      tools: {
        read_file_content: {
          description: 'Read a file.',
          async execute() {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 10);
            });
            active--;
            return 'source';
          },
          inputSchema: z.object({filePath: z.string()}),
        },
      },
    });

    expect(maxActive).to.equal(6);
  });

  it('serializes mixed read-only and host-command worker batches', async () => {
    let streamCount = 0;
    let active = 0;
    let maxActive = 0;
    const executionOrder: string[] = [];
    const model = {
      bindTools() {
        return {
          async *stream() {
            streamCount++;
            yield streamCount === 1
              ? new AIMessageChunk({
                content: '',
                tool_calls: [
                  {args: {filePath: 'src/index.ts'}, id: 'read', name: 'read_file_content', type: 'tool_call'},
                  {args: {command: 'pwd'}, id: 'command', name: 'execute_command', type: 'tool_call'},
                ],
              })
              : new AIMessageChunk({content: 'Done.'});
          },
        };
      },
    };
    const execute = async (name: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      executionOrder.push(name);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      active--;
      return name;
    };

    await executeLangChainToolLoop({
      maxToolSteps: 4,
      model: model as never,
      prompt: 'Inspect safely.',
      systemPrompt: 'Use tools.',
      tools: {
        execute_command: {
          description: 'Run a host command.',
          execute: () => execute('execute_command'),
          inputSchema: z.object({command: z.string()}),
        },
        read_file_content: {
          description: 'Read a file.',
          execute: () => execute('read_file_content'),
          inputSchema: z.object({filePath: z.string()}),
        },
      },
    });

    expect(maxActive).to.equal(1);
    expect(executionOrder).to.deep.equal(['read_file_content', 'execute_command']);
  });
});
