import { AIMessage } from '@langchain/core/messages';
import { expect } from 'chai';

import {normalizeProviderToolCalls} from '../src/core/providers/tool-call-normalizer.js';
  it('#32 strips DSML block but keeps surrounding prose when tools are disabled', () => {
    const message = new AIMessage(
      '## Final Report\n\n' +
      `${START}` +
      '<｜｜DSML｜｜invoke name="finish_task">' +
      '</｜｜DSML｜｜invoke>' +
      `${END}` +
      '\n\nEverything is fixed.',
    );

    const normalized = normalizeProviderToolCalls(message, 'deepseek', {allowTextEncodedToolCalls: false});

    expect(AIMessage.isInstance(normalized)).to.equal(true);
    const text = String(normalized.content);
    expect(text).to.contain('## Final Report');
    expect(text).to.contain('Everything is fixed.');
    expect(text).to.not.contain('tool_calls');
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
    expect(normalized.tool_calls).to.have.length(0);
  });

  it('#32 throws only when DSML is the whole output after tools are disabled', () => {
    const message = new AIMessage(
      `${START}` +
      '<｜｜DSML｜｜invoke name="finish_task">' +
      '</｜｜DSML｜｜invoke>' +
      `${END}`,
    );

    expect(() =>
      normalizeProviderToolCalls(message, 'deepseek', {allowTextEncodedToolCalls: false}),
    ).to.throw(/no prose|finalization|tool call/i);
  });

const START = '<｜｜DSML｜｜tool_calls>';
const END = '</｜｜DSML｜｜tool_calls>';

describe('provider tool-call normalizer', () => {
  it('converts DeepSeek DSML tool calls into canonical LangChain calls', () => {
    const message = new AIMessage(
      `${START}` +
      '<｜｜DSML｜｜invoke name="read_file_content">' +
      '<｜｜DSML｜｜parameter name="filePath" string="true">src/a&amp;b.ts</｜｜DSML｜｜parameter>' +
      '<｜｜DSML｜｜parameter name="startLine" string="false">100</｜｜DSML｜｜parameter>' +
      '<｜｜DSML｜｜parameter name="endLine" string="false">250</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke>' +
      `${END}`,
    );

    const normalized = normalizeProviderToolCalls(message, 'deepseek');

    expect(AIMessage.isInstance(normalized)).to.equal(true);
    expect(normalized.content).to.equal('');
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
    expect(normalized.tool_calls).to.have.length(1);
    expect(normalized.tool_calls?.[0]).to.deep.include({
      args: {
        endLine: 250,
        filePath: 'src/a&b.ts',
        startLine: 100,
      },
      name: 'read_file_content',
      type: 'tool_call',
    });
    expect(normalized.tool_calls?.[0]?.id).to.match(
      /^dsml_0_[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
    );
  });

  it('supports multiple invocations and JSON-valued parameters', () => {
    const message = new AIMessage(
      `${START}` +
      '<｜｜DSML｜｜invoke name="search_codebase">' +
      String.raw`<｜｜DSML｜｜parameter string="true" name="pattern">exec\(</｜｜DSML｜｜parameter>` +
      '<｜｜DSML｜｜parameter name="options" string="false">{"limit":10,"strict":true}</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke>' +
      '<｜｜DSML｜｜invoke name="list_directory">' +
      '<｜｜DSML｜｜parameter name="path" string="true">src</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke>' +
      `${END}`,
    );

    const normalized = normalizeProviderToolCalls(message, ' DeepSeek ');

    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
    expect(normalized.tool_calls?.map((call) => call.name)).to.deep.equal([
      'search_codebase',
      'list_directory',
    ]);
    expect(normalized.tool_calls?.[0]?.args).to.deep.equal({
      options: {limit: 10, strict: true},
      pattern: String.raw`exec\(`,
    });
  });

  it('normalizes the compact DeepSeek DSML delimiter variant', () => {
    const normalized = normalizeProviderToolCalls(new AIMessage(
      '<｜DSML｜tool_calls>' +
      '<｜DSML｜invoke name="search_codebase">' +
      String.raw`<｜DSML｜parameter name="regexPattern" string="true">new Token\(</｜DSML｜parameter>` +
      '<｜DSML｜parameter name="fileExtension" string="true">.ts</｜DSML｜parameter>' +
      '</｜DSML｜invoke>' +
      '</｜DSML｜tool_calls>',
    ), 'deepseek');

    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
    expect(normalized.content).to.equal('');
    expect(normalized.tool_calls?.[0]).to.deep.include({
      args: {fileExtension: '.ts', regexPattern: String.raw`new Token\(`},
      name: 'search_codebase',
      type: 'tool_call',
    });
  });

  it('deduplicates native and DSML calls with differently ordered object keys', () => {
    const message = new AIMessage({
      content:
        `${START}<｜｜DSML｜｜invoke name="search_codebase">` +
        '<｜｜DSML｜｜parameter name="options" string="false">{"limit":10,"strict":true}</｜｜DSML｜｜parameter>' +
        `</｜｜DSML｜｜invoke>${END}`,
      tool_calls: [{
        args: {options: {limit: 10, strict: true}},
        id: 'native-call',
        name: 'search_codebase',
        type: 'tool_call',
      }],
    });

    const normalized = normalizeProviderToolCalls(message, 'deepseek');

    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
    expect(normalized.tool_calls).to.have.length(1);
    expect(normalized.tool_calls?.[0]?.id).to.equal('native-call');
  });

  it('does not interpret DSML for other providers', () => {
    const message = new AIMessage(`${START}${END}`);
    expect(normalizeProviderToolCalls(message, 'openai')).to.equal(message);
  });

  it('normalizes current-response Qwen arguments and assigns a matching call ID', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{
        args: '{"filePath":"src/index.ts","startLine":1}' as unknown as Record<string, unknown>,
        id: '',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });

    const normalized = normalizeProviderToolCalls(message, 'qwen');

    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
    expect(normalized.tool_calls?.[0]?.args).to.deep.equal({
      filePath: 'src/index.ts',
      startLine: 1,
    });
    expect(normalized.tool_calls?.[0]?.id).to.match(/^call_0_[\da-f-]{36}$/u);
  });

  for (const provider of [
    'anthropic',
    'azure',
    'deepseek',
    'google',
    'mistral',
    'moonshot',
    'nvidia',
    'ollama',
    'openai',
    'openrouter',
    'qwen',
  ]) {
    it(`assigns a canonical ID to ID-less ${provider} structured calls`, () => {
      const normalized = normalizeProviderToolCalls(new AIMessage({
        content: '',
        tool_calls: [{
          args: {summary: 'Complete.'},
          id: undefined,
          name: 'finish_task',
          type: 'tool_call',
        }],
      }), provider);

      if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
      expect(normalized.tool_calls?.[0]?.id).to.match(/^call_0_[\da-f-]{36}$/u);
    });
  }

  it('rejects non-mapping current-response arguments before tool execution', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{
        args: '[["filePath","src/index.ts"]]' as unknown as Record<string, unknown>,
        id: 'call-1',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });

    expect(() => normalizeProviderToolCalls(message, 'qwen'))
      .to.throw('arguments must be a JSON object');
  });

  it('rejects malformed parameters instead of executing partial calls', () => {
    const message = new AIMessage(
      `${START}` +
      '<｜｜DSML｜｜invoke name="read_file_content">' +
      '<｜｜DSML｜｜parameter name="startLine" string="false">one hundred</｜｜DSML｜｜parameter>' +
      '</｜｜DSML｜｜invoke>' +
      `${END}`,
    );

    expect(() => normalizeProviderToolCalls(message, 'deepseek'))
      .to.throw('non-string tool parameter that is not valid JSON');
  });

  it('rejects a response when any DSML tool-call block is empty', () => {
    const message = new AIMessage(
      '<｜DSML｜tool_calls>' +
      '<｜DSML｜invoke name="list_directory">' +
      '<｜DSML｜parameter name="directoryPath" string="true">src</｜DSML｜parameter>' +
      '</｜DSML｜invoke>' +
      '</｜DSML｜tool_calls>' +
      '<｜DSML｜tool_calls></｜DSML｜tool_calls>',
    );

    expect(() => normalizeProviderToolCalls(message, 'deepseek'))
      .to.throw('empty DSML tool-call block');
  });

  it('rejects unknown and duplicate protocol attributes', () => {
    const unknownAttribute = new AIMessage(
      `${START}<｜｜DSML｜｜invoke name="read_file_content" unsafe="true">` +
      `</｜｜DSML｜｜invoke>${END}`,
    );
    const duplicateAttribute = new AIMessage(
      `${START}<｜｜DSML｜｜invoke name="read_file_content" name="list_directory">` +
      `</｜｜DSML｜｜invoke>${END}`,
    );

    expect(() => normalizeProviderToolCalls(unknownAttribute, 'deepseek'))
      .to.throw('unsupported attribute');
    expect(() => normalizeProviderToolCalls(duplicateAttribute, 'deepseek'))
      .to.throw('duplicate attribute');
  });

  it('uses unique IDs when a provider repeats an identical call in a later turn', () => {
    const content =
      `${START}<｜｜DSML｜｜invoke name="list_directory">` +
      '<｜｜DSML｜｜parameter name="directoryPath" string="true">src</｜｜DSML｜｜parameter>' +
      `</｜｜DSML｜｜invoke>${END}`;
    const first = normalizeProviderToolCalls(new AIMessage(content), 'deepseek');
    const second = normalizeProviderToolCalls(new AIMessage(content), 'deepseek');
    if (!AIMessage.isInstance(first) || !AIMessage.isInstance(second)) {
      throw new Error('Expected AI messages.');
    }

    expect(first.tool_calls?.[0]?.id).not.to.equal(second.tool_calls?.[0]?.id);
  });

  it('rejects text-encoded calls when stage tools have been disabled', () => {
    const message = new AIMessage(
      `${START}` +
      '<｜｜DSML｜｜invoke name="read_file_content"></｜｜DSML｜｜invoke>' +
      `${END}`,
    );

    expect(() => normalizeProviderToolCalls(message, 'deepseek', {
      allowTextEncodedToolCalls: false,
    })).to.throw('after tools were disabled');
  });
});
