import { expect } from 'chai';

import type { AgentStreamEvent } from '../src/core/agent.js';

import { processAgentStream } from '../src/core/stream-processor.js';

describe('processAgentStream', () => {
  it('streams only public assistant text without duplicating completed blocks', async () => {
    const events = [
      messageEvent('CodebaseIntelligence', 'content-block-delta', { text: '<repo_map>internal</repo_map>', type: 'text-delta' }),
      messageEvent('SastAuditor', 'content-block-delta', { text: '<sast_report>internal</sast_report>', type: 'text-delta' }),
      messageEvent('DevilsAdvocate', 'content-block-delta', { text: '<verdicts_json>[]</verdicts_json>', type: 'text-delta' }),
      messageEvent('ReportingAgent', 'content-block-delta', { text: 'I will call tools.', type: 'text-delta' }),
      toolUpdate('ReportingTools', [
        { tool_calls: [{ args: { summary: 'done' }, id: 'finish-1', name: 'finish_task' }] },
        { content: 'done', name: 'finish_task', tool_call_id: 'finish-1', type: 'tool' },
      ]),
      messageEvent('ReportingAgent', 'content-block-start', { text: '# Final report', type: 'text' }),
      messageEvent('ReportingAgent', 'content-block-delta', { text: '# Final report', type: 'text-delta' }),
      messageEvent('ReportingAgent', 'content-block-finish', { text: '# Final report', type: 'text' }),
    ];
    const chunks: string[] = [];

    const result = await processAgentStream(
      (chunk) => chunks.push(chunk),
      () => {},
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor(events),
      },
    );

    expect(chunks.join('')).to.equal('# Final report');
    expect(result.fullResponse).to.equal('# Final report');
  });

  it('emits concise tool activity without graph node names or raw tool labels', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];
    const toolUpdateEvent = {
      method: 'updates',
      params: {
        data: {
          ToolExecutor: {
            messages: [
              { tool_calls: [{ args: { command: 'npm test' }, id: 'call-1', name: 'execute_command' }] },
              {
                content: '356 passing\n0 failing',
                name: 'execute_command',
                tool_call_id: 'call-1',
                type: 'tool',
              },
            ],
          },
        },
        node: 'ToolExecutor',
      },
      type: 'event',
    };
    const events = [toolUpdateEvent, toolUpdateEvent];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor(events),
      },
    );

    expect(
      emitted
        .filter((event) => event.kind === 'tool_call' || event.kind === 'tool_result')
        .map((event) => event.message),
    ).to.deep.equal(['Running a command', 'Ran a command']);
    expect(emitted[0]?.detail).to.equal('$ npm test');
    expect(emitted[1]?.resultPreview).to.equal('356 passing');
  });

  it('marks failed tool results and redacts secrets from public activity', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        workflow: workflowFor([toolUpdate('SastTools', [
          {
            tool_calls: [{
              args: {command: 'curl -H "Authorization: Bearer-secret" https://example.test'},
              id: 'command-1',
              name: 'execute_command',
            }],
          },
          {
            content: '[ERROR] api_key=super-secret request failed',
            name: 'execute_command',
            status: 'error',
            tool_call_id: 'command-1',
            type: 'tool',
          },
        ])]),
      },
    );

    const toolEvents = emitted.filter(
      (event) => event.kind === 'tool_call' || event.kind === 'tool_result',
    );
    expect(toolEvents[0]?.detail).not.to.include('Bearer-secret');
    expect(toolEvents[1]?.resultPreview).not.to.include('super-secret');
    expect(toolEvents[1]?.succeeded).to.equal(false);
  });

  it('streams safe progress and tool activity with the owning agent tag', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];
    const events = [
      messageEvent('SastAuditor', 'content-block-start', { text: '', type: 'text' }),
      messageEvent('SastAuditor', 'content-block-delta', {
        text: 'Tracing attacker-controlled paths into filesystem sinks.',
        type: 'text-delta',
      }),
      messageEvent('SastAuditor', 'content-block-finish', {
        text: 'Tracing attacker-controlled paths into filesystem sinks.',
        type: 'text',
      }),
      toolUpdate('SastTools', [
        { tool_calls: [{ args: { pattern: 'readFile' }, id: 'search-1', name: 'search_codebase' }] },
        {
          content: '2 matches',
          name: 'search_codebase',
          tool_call_id: 'search-1',
          type: 'tool',
        },
      ]),
    ];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor(events),
      },
    );

    const progress = emitted.find((event) => event.kind === 'agent_progress');
    expect(progress).to.include({
      agent: 'SAST Auditor',
      message: 'Tracing attacker-controlled paths into filesystem sinks.',
      stage: 'sast_audit',
    });

    expect(
      emitted.filter((event) => event.kind === 'tool_call' || event.kind === 'tool_result'),
    ).to.satisfy((events: Array<Omit<AgentStreamEvent, 'timestamp'>>) =>
      events.every((event) => event.agent === 'SAST Auditor' && event.stage === 'sast_audit'));
  });

  it('streams configured provider reasoning summaries with the owning agent tag', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];
    const summary = 'I will trace the request boundary before validating the filesystem sink.';

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        providerHint: 'azure',
        reasoningSummaryEnabled: true,
        workflow: workflowFor([
          messageEvent('SastAuditor', 'content-block-start', {type: 'reasoning'}),
          messageEvent('SastAuditor', 'content-block-delta', {
            text: summary,
            type: 'reasoning-delta',
          }),
          messageEvent('SastAuditor', 'content-block-finish', {
            reasoning: summary,
            type: 'reasoning',
          }),
        ]),
      },
    );

    expect(emitted.filter((event) => event.kind === 'agent_progress')).to.deep.include({
      agent: 'SAST Auditor',
      kind: 'agent_progress',
      message: summary,
      stage: 'sast_audit',
    });
  });

  it('never exposes DeepSeek raw reasoning content as public progress', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        providerHint: 'deepseek',
        reasoningSummaryEnabled: true,
        workflow: workflowFor([
          messageEvent('SastAuditor', 'content-block-start', {type: 'reasoning'}),
          messageEvent('SastAuditor', 'content-block-delta', {
            text: 'private chain of thought',
            type: 'reasoning-delta',
          }),
          messageEvent('SastAuditor', 'content-block-finish', {
            reasoning: 'private chain of thought',
            type: 'reasoning',
          }),
        ]),
      },
    );

    expect(emitted.some((event) => event.message.includes('private chain of thought'))).to.equal(false);
    expect(emitted).to.deep.include({
      agent: 'SAST Auditor',
      kind: 'agent_progress',
      message: 'Analyzing evidence and selecting the next audit action.',
      stage: 'sast_audit',
    });
  });

  it('never exposes DeepSeek DSML tool protocol as agent progress', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        providerHint: 'deepseek',
        workflow: workflowFor([
          messageEvent('DevilsAdvocate', 'content-block-start', {type: 'text'}),
          messageEvent('DevilsAdvocate', 'content-block-delta', {
            text: '<｜DSML｜tool_calls><｜DSML｜invoke name="read_file_content">SECRET_A',
            type: 'text-delta',
          }),
          messageEvent('DevilsAdvocate', 'content-block-finish', {
            text: '<｜DSML｜tool_calls><｜DSML｜invoke name="read_file_content">SECRET_A',
            type: 'text',
          }),
          messageEvent('DevilsAdvocate', 'content-block-start', {type: 'text'}),
          messageEvent('DevilsAdvocate', 'content-block-delta', {
            text: 'SECRET_B',
            type: 'text-delta',
          }),
          messageEvent('DevilsAdvocate', 'content-block-finish', {
            text: 'SECRET_B',
            type: 'text',
          }),
          messageEvent('DevilsAdvocate', 'content-block-start', {type: 'text'}),
          messageEvent('DevilsAdvocate', 'content-block-delta', {
            text: '</｜DSML｜invoke></｜DSML｜tool_calls>',
            type: 'text-delta',
          }),
          messageEvent('DevilsAdvocate', 'content-block-finish', {
            text: '</｜DSML｜invoke></｜DSML｜tool_calls>',
            type: 'text',
          }),
        ]),
      },
    );

    expect(emitted.some((event) => event.message.includes('DSML'))).to.equal(false);
    expect(emitted.some((event) => event.message.includes('read_file_content'))).to.equal(false);
    expect(emitted.some((event) => event.message.includes('SECRET'))).to.equal(false);
  });

  it('never exposes split DeepSeek DSML from the public reporting stream', async () => {
    const chunks: string[] = [];

    await processAgentStream(
      (chunk) => chunks.push(chunk),
      () => {},
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        providerHint: 'deepseek',
        workflow: workflowFor([
          toolUpdate('ReportingTools', [
            {tool_calls: [{args: {summary: 'done'}, id: 'finish-1', name: 'finish_task'}]},
            {content: 'done', name: 'finish_task', tool_call_id: 'finish-1', type: 'tool'},
          ]),
          messageEvent('ReportingAgent', 'content-block-start', {type: 'text'}),
          messageEvent('ReportingAgent', 'content-block-delta', {
            text: '# Safe report\n<｜｜DS',
            type: 'text-delta',
          }),
          messageEvent('ReportingAgent', 'content-block-delta', {
            text: 'ML｜｜tool_calls><｜｜DSML｜｜invoke name="read_file_content">' +
              '<｜｜DSML｜｜parameter name="filePath" string="true">SECRET_PATH',
            type: 'text-delta',
          }),
          messageEvent('ReportingAgent', 'content-block-finish', {
            text: '# Safe report\n<｜｜DSML｜｜tool_calls>incomplete',
            type: 'text',
          }),
        ]),
      },
    );

    expect(chunks.join('')).to.equal('# Safe report\n');
    expect(chunks.join('')).not.to.include('SECRET_PATH');
    expect(chunks.join('')).not.to.include('DSML');
  });

  it('discards an incomplete DeepSeek marker prefix at stream completion', async () => {
    const chunks: string[] = [];

    await processAgentStream(
      (chunk) => chunks.push(chunk),
      () => {},
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        providerHint: 'deepseek',
        workflow: workflowFor([
          toolUpdate('ReportingTools', [
            {tool_calls: [{args: {summary: 'done'}, id: 'finish-1', name: 'finish_task'}]},
            {content: 'done', name: 'finish_task', tool_call_id: 'finish-1', type: 'tool'},
          ]),
          messageEvent('ReportingAgent', 'content-block-start', {type: 'text'}),
          messageEvent('ReportingAgent', 'content-block-delta', {
            text: '# Safe report\n<｜｜DS',
            type: 'text-delta',
          }),
          messageEvent('ReportingAgent', 'content-block-finish', {
            text: '# Safe report\n<｜｜DS',
            type: 'text',
          }),
        ]),
      },
    );

    expect(chunks.join('')).to.equal('# Safe report\n');
  });

  it('does not expose structured stage handoffs as progress', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];
    const handoff = '<sast_report>private artifact</sast_report>';

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor([
          messageEvent('SastAuditor', 'content-block-start', { text: '', type: 'text' }),
          messageEvent('SastAuditor', 'content-block-delta', { text: handoff, type: 'text-delta' }),
          messageEvent('SastAuditor', 'content-block-finish', { text: handoff, type: 'text' }),
        ]),
      },
    );

    expect(emitted.some((event) => event.message.includes('private artifact'))).to.equal(false);
  });

  it('tracks candidates and accumulates confirmed findings across stage updates', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        workflow: workflowFor([
          updateEvent('SastAuditor', {
            sastAudit: {candidates: [{findingId: 'VULN-1'}, {findingId: 'VULN-2'}]},
          }),
          updateEvent('DevilsAdvocate', {
            verdicts: [{findingId: 'VULN-1', verdict: 'CONFIRMED'}],
          }),
          updateEvent('DevilsAdvocate', {
            verdicts: [{findingId: 'VULN-2', verdict: 'REJECTED'}],
          }),
          updateEvent('ReportingAgent', {
            pipelineFindings: [{vulnId: 'VULN-1'}],
          }),
        ]),
      },
    );

    const telemetry = emitted
      .filter((event) =>
        event.kind === 'audit_telemetry' && event.message === 'Audit telemetry updated.'
      )
      .map((event) => event.auditTelemetry);
    expect(telemetry).to.deep.equal([
      {
        activeStage: 'sast_audit',
        candidateIds: ['VULN-1', 'VULN-2'],
        verifiedFindingIds: [],
      },
      {
        activeStage: 'devils_advocate',
        candidateIds: ['VULN-2'],
        verifiedFindingIds: ['VULN-1'],
      },
      {
        activeStage: 'devils_advocate',
        candidateIds: [],
        verifiedFindingIds: ['VULN-1'],
      },
      {
        activeStage: 'reporting',
        candidateIds: [],
        verifiedFindingIds: ['VULN-1'],
      },
    ]);
    expect(emitted.map((event) => event.message)).to.include(
      'Passing candidate findings to the Devil’s Advocate for adversarial verification.',
    );
  });

  it('records ID-less provider usage using the LangGraph protocol sequence', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];
    const update = {
      ...updateEvent('SastAuditor', {
      messages: [{usage_metadata: {input_tokens: 12, output_tokens: 3, total_tokens: 15}}],
      }),
      namespace: 'audit',
      seq: 42,
      timestamp: '2026-08-04T00:00:00.000Z',
    };

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        workflow: workflowFor([update, update]),
      },
    );

    expect(emitted.filter((event) => event.kind === 'token_usage')).to.deep.equal([{
      agent: 'SAST Auditor',
      kind: 'token_usage',
      message: 'Model usage recorded.',
      stage: 'sast_audit',
      usage: {
        completion: 3,
        prompt: 12,
        total: 15,
        totalSource: 'provider',
        unclassified: 0,
      },
    }]);
  });

  it('normalizes and de-duplicates final provider usage metadata', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];
    const completedMessage = {
      id: 'response-1',
      usage_metadata: {
        input_tokens: 120,
        output_token_details: {reasoning: 30},
        output_tokens: 50,
        total_tokens: 170,
      },
    };

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        workflow: workflowFor([
          updateEvent('SastAuditor', {messages: [completedMessage]}),
          updateEvent('SastAuditor', {messages: [completedMessage]}),
        ]),
      },
    );

    const usageEvents = emitted.filter((event) => event.kind === 'token_usage');
    expect(usageEvents).to.have.length(1);
    expect(usageEvents[0]?.usage).to.deep.equal({
      completion: 50,
      prompt: 120,
      total: 170,
      totalSource: 'provider',
      unclassified: 0,
    });
  });

  it('requires successful inspection and finish-task results for audit evidence', async () => {
    const result = await processAgentStream(
      () => {},
      () => {},
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor([{
          method: 'updates',
          params: {
            data: {
              ToolExecutor: {
                messages: [
                  { tool_calls: [{ args: { filePath: 'src/app.ts' }, id: 'read-1', name: 'read_file_content' }] },
                  { content: 'source', name: 'read_file_content', tool_call_id: 'read-1', type: 'tool' },
                  { tool_calls: [{ args: {}, id: 'finish-1', name: 'finish_task' }] },
                  { content: 'done', name: 'finish_task', tool_call_id: 'finish-1', type: 'tool' },
                ],
              },
            },
          },
          type: 'event',
        }]),
      },
    );

    expect(result.evidenceActions).to.equal(1);
    expect(result.finishTaskCompleted).to.equal(true);
    expect(result.inspectedPaths).to.deep.equal(['src/app.ts']);
    expect(result.reportFindingsAccepted).to.equal(true);
  });

  it('attributes LangGraph v3 update envelopes to their emitting stage', async () => {
    const emitted: Array<Omit<AgentStreamEvent, 'timestamp'>> = [];

    await processAgentStream(
      () => {},
      (event) => emitted.push(event),
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        workflow: workflowFor([{
          method: 'updates',
          params: {
            data: {
              node: 'SastTools',
              values: {
                messages: [
                  {tool_calls: [{args: {filePath: 'src/app.ts'}, id: 'read-v3', name: 'read_file_content'}]},
                  {content: 'source', name: 'read_file_content', tool_call_id: 'read-v3', type: 'tool'},
                ],
              },
            },
            node: 'SastTools',
          },
          type: 'event',
        }]),
      },
    );

    const toolEvents = emitted.filter((event) =>
      event.kind === 'tool_call' || event.kind === 'tool_result',
    );
    expect(toolEvents).to.have.length(2);
    expect(toolEvents.every((event) => event.stage === 'sast_audit')).to.equal(true);
    expect(toolEvents.every((event) => event.agent === 'SAST Auditor')).to.equal(true);
  });

  it('does not accept terminal completion after a rejected finding', async () => {
    const result = await processAgentStream(
      () => {},
      () => {},
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor([{
          method: 'updates',
          params: {
            data: {
              ToolExecutor: {
                messages: [
                  { tool_calls: [{ args: {}, id: 'report-1', name: 'report_finding' }] },
                  {
                    content: JSON.stringify({ accepted: false, reason: 'duplicate' }),
                    name: 'report_finding',
                    tool_call_id: 'report-1',
                    type: 'tool',
                  },
                  { tool_calls: [{ args: {}, id: 'finish-1', name: 'finish_task' }] },
                  { content: 'done', name: 'finish_task', tool_call_id: 'finish-1', type: 'tool' },
                ],
              },
            },
          },
          type: 'event',
        }]),
      },
    );

    expect(result.finishTaskCompleted).to.equal(true);
    expect(result.reportFindingsAccepted).to.equal(false);
  });

  it('preserves a rejected finding when the final checkpoint contains report prose', async () => {
    const result = await processAgentStream(
      () => {},
      () => {},
      {
        inputs: {},
        lcConfig: { configurable: { thread_id: 'test' }, version: 'v3' },
        logLabel: 'test',
        workflow: workflowFor([{
          method: 'updates',
          params: {
            data: {
              ToolExecutor: {
                messages: [
                  {tool_calls: [{args: {}, id: 'report-1', name: 'report_finding'}]},
                  {
                    content: JSON.stringify({accepted: false, message: 'Rejected'}),
                    name: 'report_finding',
                    tool_call_id: 'report-1',
                    type: 'tool',
                  },
                ],
              },
            },
            node: 'ToolExecutor',
          },
          type: 'event',
        }], {
          pipelineReport: '# Untrusted report prose',
        }),
      },
    );

    expect(result.reportFindingsAccepted).to.equal(false);
  });

  it('recovers completion evidence from durable checkpoint state without replayed tool events', async () => {
    const result = await processAgentStream(
      () => {},
      () => {},
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        workflow: workflowFor([], {
          auditedFiles: ['src/api.ts', 'src/auth.ts'],
          evidenceActions: 3,
          pipelineReport: '# Verified report',
        }),
      },
    );

    expect(result.finishTaskCompleted).to.equal(true);
    expect(result.reportFindingsAccepted).to.equal(true);
    expect(result.evidenceActions).to.equal(3);
    expect(result.inspectedPaths).to.deep.equal(['src/api.ts', 'src/auth.ts']);
    expect(result.fullResponse).to.equal('# Verified report');
  });

  it('filters incomplete DeepSeek protocol prefixes from checkpoint report fallback', async () => {
    const chunks: string[] = [];
    const result = await processAgentStream(
      (chunk) => chunks.push(chunk),
      () => {},
      {
        inputs: {},
        lcConfig: {configurable: {thread_id: 'test'}, version: 'v3'},
        logLabel: 'test',
        providerHint: 'deepseek',
        workflow: workflowFor([], {
          pipelineReport: '# Verified report\n<｜｜DS',
        }),
      },
    );

    expect(chunks.join('')).to.equal('# Verified report\n');
    expect(result.fullResponse).to.equal('# Verified report\n');
  });
});

function messageEvent(node: string, event: string, payload: Record<string, string>) {
  const field = event === 'content-block-delta' ? 'delta' : 'content';
  return {
    method: 'messages',
    params: { data: { event, [field]: payload }, node },
    type: 'event',
  };
}

function toolUpdate(node: string, messages: unknown[]) {
  return {
    method: 'updates',
    params: {data: {[node]: {messages}}, node},
    type: 'event',
  };
}

function updateEvent(node: string, update: Record<string, unknown>, runId?: string) {
  return {
    method: 'updates',
    params: {data: {[node]: update}, node, ...(runId ? {run_id: runId} : {})},
    type: 'event',
  };
}

function workflowFor(events: unknown[], values: Record<string, unknown> = {}) {
  return {
    async getState() {
      return {values};
    },
    async *streamEvents() {
      for (const event of events) yield event;
    },
  } as never;
}
