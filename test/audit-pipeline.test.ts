import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';

import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { expect } from 'chai';
import { z } from 'zod';

import type { ToolEntry } from '../src/core/graph/tool-retriever.js';
import type { MissionRuntimeObserver } from '../src/core/orchestrator/mission-runtime.js';

import {
  calculateWorkflowRecursionLimit,
  compileWorkflow,
  WORKFLOW_RECURSION_LIMIT,
} from '../src/core/graph/workflow.js';
import { normalizeAssistantHistoryMessage } from '../src/core/providers/message-normalizer.js';

describe('deterministic audit pipeline', () => {
  it('scales the graph recursion ceiling with configured stage tool budgets', () => {
    expect(calculateWorkflowRecursionLimit({
      maxToolSteps: 1024,
      toolPolicy: {
        agents: {
          codebase_intelligence: {maxToolSteps: 256},
          devils_advocate: {maxToolSteps: 512},
          reporting: {maxToolSteps: 64},
          sast_audit: {maxToolSteps: 1024},
        },
      },
    })).to.equal((256 + 512 + 64 + 1024) * 2 + 32);
  });

  it('never exposes repository-mutation tools to investigation stages', () => {
    const bindings: string[][] = [];

    compileWorkflow({
      model: createModel(
        () => new AIMessage('unused'),
        (names) => bindings.push(names),
      ),
      systemPrompt: 'You are Shadow.',
      tools: [
        ...tools(),
        mutationTool('apply_and_test_patch'),
        mutationTool('untrusted_mcp__write_repository'),
      ],
    });

    expect(bindings).to.have.length(4);
    expect(bindings.flat()).not.to.include('apply_and_test_patch');
    expect(bindings.flat()).not.to.include('untrusted_mcp__write_repository');
    expect(bindings[1]).to.include('read_file_content');
    expect(bindings[3]).to.include('read_file_content');
  });

  it('exposes the host terminal only to the SAST and adversarial stages', () => {
    const bindings: string[][] = [];

    compileWorkflow({
      model: createModel(
        () => new AIMessage('unused'),
        (names) => bindings.push(names),
      ),
      systemPrompt: 'You are Shadow.',
      tools: [...tools(), investigationTool('execute_command')],
    });

    expect(bindings).to.have.length(4);
    expect(bindings[0]).not.to.include('execute_command');
    expect(bindings[1]).to.include('execute_command');
    expect(bindings[2]).not.to.include('execute_command');
    expect(bindings[3]).to.include('execute_command');
  });

  it('normalizes streamed assistant history for Responses tool loops', () => {
    const chunk = new AIMessageChunk({
      content: [{text: 'Inspecting the repository.', type: 'input_text'}],
      tool_calls: [{
        args: {filePath: 'src/index.ts'},
        id: 'read-map',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });
    chunk.response_metadata = {
      output: [{
        content: [{text: 'Inspecting the repository.', type: 'input_text'}],
        role: 'assistant',
        type: 'message',
      }],
      output_version: 'v1',
    };

    const normalized = normalizeAssistantHistoryMessage(chunk);

    expect(AIMessage.isInstance(normalized)).to.equal(true);
    expect(normalized.content).to.deep.equal([
      {text: 'Inspecting the repository.', type: 'text'},
    ]);
    expect(normalized.response_metadata).not.to.have.property('output');
    expect(normalized.response_metadata).not.to.have.property('output_version');
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected normalized AI message.');
    expect(normalized.tool_calls?.[0]?.name).to.equal('read_file_content');
  });

  it('strips private reasoning blocks before replaying history to chat-completions providers', () => {
    const message = new AIMessage({
      content: [
        {summary: [{text: 'private chain of thought', type: 'summary_text'}], type: 'reasoning'},
        {text: 'Public security conclusion.', type: 'text'},
        {text: 'legacy public text', type: 'input_text'},
        {signature: 'provider-signature', thinking: 'private thought', type: 'thinking'},
      ] as unknown as AIMessage['content'],
      tool_calls: [{
        args: {filePath: 'src/index.ts'},
        id: 'read-reasoning',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });
    message.response_metadata = {
      output_version: 'v1',
      reasoning: {effort: 'high'},
      usage: {input_tokens: 10},
    };

    const normalized = normalizeAssistantHistoryMessage(message);

    expect(normalized.content).to.deep.equal([
      {text: 'Public security conclusion.', type: 'text'},
      {text: 'legacy public text', type: 'text'},
    ]);
    expect(normalized.response_metadata).to.deep.equal({usage: {input_tokens: 10}});
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected normalized AI message.');
    expect(normalized.tool_calls?.[0]).to.include({
      id: 'read-reasoning',
      name: 'read_file_content',
    });
  });

  it('preserves provider-native thought signatures for Anthropic and Google replay', () => {
    const message = new AIMessage({
      content: [
        {signature: 'provider-signature', thinking: 'private thought', type: 'thinking'},
        {text: 'Public security conclusion.', type: 'text'},
      ] as unknown as AIMessage['content'],
    });

    expect(normalizeAssistantHistoryMessage(message, 'anthropic')).to.equal(message);
    expect(normalizeAssistantHistoryMessage(message, 'google')).to.equal(message);
    expect(normalizeAssistantHistoryMessage(message, ' GOOGLE ')).to.equal(message);
    expect(normalizeAssistantHistoryMessage(message, 'deepseek').content).to.deep.equal([
      {text: 'Public security conclusion.', type: 'text'},
    ]);
  });

  it('preserves genuine OpenAI Responses replay state only for Responses providers', () => {
    const message = new AIMessage({
      additional_kwargs: {reasoning: {encrypted_content: 'opaque-replay-state'}},
      content: [{text: 'Public conclusion.', type: 'text'}],
    });
    message.response_metadata = {
      output: [{id: 'rs_1', summary: [], type: 'reasoning'}],
      output_version: 'v1',
    };

    expect(normalizeAssistantHistoryMessage(message, 'openai')).to.equal(message);
    expect(normalizeAssistantHistoryMessage(message, 'azure')).to.equal(message);
    expect(normalizeAssistantHistoryMessage(message, 'microsoft-foundry')).to.equal(message);
    expect(normalizeAssistantHistoryMessage(message, ' OpenAI ')).to.equal(message);

    const portable = normalizeAssistantHistoryMessage(message, 'deepseek');
    expect(portable).not.to.equal(message);
    expect(portable.additional_kwargs).not.to.have.property('reasoning');
    expect(portable.response_metadata).not.to.have.property('output');
  });

  it('executes every stage in order and passes validated artifacts downstream', async () => {
    const invocations: string[] = [];
    const runtimeEvents: string[] = [];
    const handoffs: Record<string, string> = {};
    const counts = new Map<string, number>();
    const stageInputs: Array<{messages: BaseMessage[]; stage: string}> = [];
    let injectedRetry = false;
    let sawResponsesSafeHistory = false;
    const model = createModel((messages) => {
      const system = String(messages[0]?.content ?? '');
      const task = String(messages[1]?.content ?? '');
      const stage = stageFromSystem(system);
      stageInputs.push({messages, stage});
      invocations.push(stage);
      handoffs[stage] = task;
      if (stage === 'codebase' && !injectedRetry) {
        injectedRetry = true;
        const error = new Error('429 transient provider throttle') as Error & {retryAfterMs: number};
        error.retryAfterMs = 0;
        throw error;
      }

      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        const response = toolCall('read-map', 'read_file_content', {filePath: 'src/index.ts'});
        response.response_metadata = {
          output: [{
            content: [{text: 'Inspecting the repository.', type: 'input_text'}],
            role: 'assistant',
            type: 'message',
          }],
        };
        return response;
      }

      if (stage === 'codebase') {
        const assistantHistory = messages.find((message) => AIMessage.isInstance(message));
        sawResponsesSafeHistory =
          assistantHistory !== undefined &&
          !('output' in assistantHistory.response_metadata);
        return new AIMessage(
          '<repo_map>\n- src/index.ts: entry point\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nInspected `src/index.ts`.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('read-audit', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nNo evidence-backed vulnerability candidates.\n</sast_report>\n' +
            '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates required review.\n</adversarial_report>\n' +
          '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('', 'finish_task', {summary: 'Audit completed with no confirmed findings.'});
      }

      return new AIMessage(
        '# Security Audit Report\n\n## Executive Summary\nNo confirmed vulnerabilities were found.',
      );
    });
    const missionRuntime: MissionRuntimeObserver = {
      async afterModelInvocation({stage}) {
        runtimeEvents.push(`model:end:${stage}`);
      },
      async afterToolExecution({stage}, results) {
        runtimeEvents.push(`tools:end:${stage}:${results.map(({callId}) => callId).join(',')}`);
      },
      async beforeModelInvocation({stage}) {
        runtimeEvents.push(`model:start:${stage}`);
        return `reservation-${stage}`;
      },
      async beforeToolExecution({stage}, calls) {
        runtimeEvents.push(`tools:start:${stage}:${calls.map(({callId}) => callId).join(',')}`);
      },
      async recordMissionCompleted() {},
      async recordMissionFailed() {},
      async recordStageCompleted(stage) {
        runtimeEvents.push(`stage:end:${stage}`);
      },
      async recordStageStarted(stage) {
        runtimeEvents.push(`stage:start:${stage}`);
      },
    };

    const workflow = compileWorkflow({
      missionRuntime,
      model,
      repoMap: '- src/index.ts',
      systemPrompt: 'You are Shadow.',
      tools: tools(),
    });
    const state = await workflow.invoke(
      {
        auditRunId: 'audit-run-1',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(invocations).to.deep.equal([
      'codebase',
      'codebase',
      'codebase',
      'sast',
      'sast',
      'devil',
      'reporter',
      'reporter',
    ]);
    expect(handoffs.sast).to.include('<repo_map>\n- src/index.ts: entry point');
    expect(handoffs.sast).to.include('<codebase_report>\n# Architecture');
    expect(handoffs.devil).to.include('<sast_report>\n# SAST');
    expect(handoffs.devil).to.include('<sast_candidates_json>\n[]');
    expect(handoffs.reporter).to.include('<adversarial_report>\n# Validation');
    expect(state.sastAudit?.candidates).to.deep.equal([]);
    expect(state.pipelineReport).to.include('# Security Audit Report');
    expect(state.pipelineFindings).to.deep.equal([]);
    expect(state.activeStage).to.equal('reporting');
    expect(sawResponsesSafeHistory).to.equal(true);
    expect(runtimeEvents.filter((event) => event.startsWith('stage:start:'))).to.deep.equal([
      'stage:start:codebase_intelligence',
      'stage:start:sast_audit',
      'stage:start:devils_advocate',
      'stage:start:reporting',
    ]);
    expect(runtimeEvents.filter((event) => event.startsWith('stage:end:'))).to.deep.equal([
      'stage:end:codebase_intelligence',
      'stage:end:sast_audit',
      'stage:end:devils_advocate',
      'stage:end:reporting',
    ]);
    expect(runtimeEvents.filter((event) => event === 'model:start:codebase_intelligence')).to.have.length(3);
    expect(runtimeEvents.filter((event) => event === 'model:end:codebase_intelligence')).to.have.length(3);
    const toolStarts = runtimeEvents.filter((event) => event.startsWith('tools:start:'));
    expect(toolStarts.length).to.be.greaterThanOrEqual(2);
    expect(toolStarts).to.satisfy((events: string[]) =>
      events.every((event) => /^tools:start:[a-z_]+:[a-z_]+:\d+:\d+$/.test(event)));
    for (const start of toolStarts) {
      expect(runtimeEvents.indexOf(start)).to.be.lessThan(
        runtimeEvents.indexOf(start.replace('tools:start:', 'tools:end:')),
      );
    }

    for (const input of stageInputs) {
      const systemMessages = input.messages.filter((message) => message._getType() === 'system');
      expect(systemMessages).to.have.length(1);
      expect(String(systemMessages[0]?.content)).not.to.include('You are Shadow.');
      for (const historyMessage of input.messages.slice(2)) {
        expect(historyMessage.additional_kwargs.auditRunId).to.equal('audit-run-1');
        expect(historyMessage.additional_kwargs.auditStage).to.equal(({
          codebase: 'codebase_intelligence',
          devil: 'devils_advocate',
          reporter: 'reporting',
          sast: 'sast_audit',
        } as Record<string, string>)[input.stage]);
      }
    }

    const codebaseRetry = stageInputs.find(
      ({messages, stage}) =>
        stage === 'codebase' &&
        messages.some((message) => ToolMessage.isInstance(message)),
    );
    expect(codebaseRetry).not.to.equal(undefined);
  });

  it('publishes host-reviewed suppressions as dismissed audit decisions', async () => {
    const counts = new Map<string, number>();
    let devilTask = '';
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);
      if (stage === 'codebase' && count === 1) {
        return toolCall('read-map', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/index.ts: request handler\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nInspected the handler.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('read-sast', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nCandidate CAND-001.\n</sast_report>\n' +
          '<sast_candidates_json>\n' +
          '[{"findingId":"CAND-001","title":"Path traversal","summary":"Input reaches a file sink",' +
          '"severity":"high","cwe":"CWE-22","confidence":0.95,"reachability":"likely",' +
          '"affectedLocations":[{"filePath":"src/index.ts","lineNumber":1}],' +
          '"sourceToSink":[{"kind":"source","location":{"filePath":"src/index.ts","lineNumber":1},' +
          '"description":"request path"},{"kind":"sink","location":{"filePath":"src/index.ts","lineNumber":2},' +
          '"description":"file read"}],"prerequisites":["Remote request access"],' +
          '"reproductionSteps":["Send a traversal path"],"proofOfConcept":{"kind":"payload",' +
          '"content":"../safe-fixture","safetyNotes":"Static proof only","executionStatus":"not_run"},' +
          '"impact":"Unauthorized file read","remediation":"Constrain paths",' +
          '"evidence":["src/index.ts:1"]}]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        devilTask = String(messages[1]?.content ?? '');
        return new AIMessage(
          '<adversarial_report>\n# Validation\nThe candidate appears reachable.\n</adversarial_report>\n' +
          '<verdicts_json>\n' +
          '[{"findingId":"CAND-001","verdict":"CONFIRMED","rationale":"Reachable sink",' +
          '"evidence":["src/index.ts:1"],"verification":{"status":"verified","method":"static trace",' +
          '"observations":["Input reaches the sink"]}}]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('finish-suppressed', 'finish_task', {
          summary: 'No publishable findings remain.',
        });
      }

      return new AIMessage('# Security Audit Report\n\nNo active findings.');
    });
    const state = await compileWorkflow({
      model,
      repoMap: '- src/index.ts',
      suppressionStore: {
        async match(candidate) {
          return candidate.findingId === 'CAND-001' ? {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            rationale: 'The route is constrained by a reviewed allowlist.',
            reviewer: 'Security Lead',
          } : null;
        },
      },
      systemPrompt: 'You are Shadow.',
      tools: tools(),
    }).invoke({
      auditRunId: 'audit-run-suppression',
      messages: [new HumanMessage('Audit this repository.')],
      mission: 'Audit this repository.',
    }, {recursionLimit: WORKFLOW_RECURSION_LIMIT});

    expect(devilTask).to.include('<host_reviewed_false_positive_memory>');
    expect(devilTask).to.include('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(state.devilsAdvocate?.verdicts[0]?.verdict).to.equal('DISMISSED');
    expect(state.devilsAdvocate?.reportMarkdown).to.include('Host-Reviewed Suppressions');
    expect(state.pipelineFindings).to.deep.equal([]);
  });

  it('records only confirmed findings with exact SAST provenance', async () => {
    let sourceReportToolExecutions = 0;
    const stageCounts = new Map<string, number>();
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (stageCounts.get(stage) ?? 0) + 1;
      stageCounts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return toolCall('read-map-1', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/index.ts: request handler\n</repo_map>\n' +
            '<codebase_report>\n# Architecture\nInspected the request handler.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('read-1', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nCAND-001 is a verified path traversal candidate.\n</sast_report>\n' +
            '<sast_candidates_json>\n' +
            '[{"findingId":"CAND-001","title":"Path traversal","summary":"Input reaches a file sink",' +
            '"severity":"high","cwe":"CWE-22","confidence":0.95,"reachability":"verified",' +
            '"affectedLocations":[{"filePath":"src/index.ts","lineNumber":1},' +
            '{"filePath":"src/index.ts","lineNumber":2}],' +
            '"sourceToSink":[{"kind":"source","location":{"filePath":"src/index.ts","lineNumber":1},' +
            '"description":"request path"},{"kind":"sink","location":{"filePath":"src/index.ts","lineNumber":2},' +
            '"description":"file read"}],"prerequisites":["Remote request access"],' +
            '"reproductionSteps":["Send a traversal path"],"proofOfConcept":{"kind":"payload",' +
            '"content":"../safe-fixture","safetyNotes":"Uses a local fixture only","executionStatus":"not_run"},' +
            '"impact":"Unauthorized file read",' +
            '"remediation":"Resolve and constrain paths to the trusted root","evidence":["src/index.ts:1"]}]\n' +
            '</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nCAND-001 remained reproducible.\n</adversarial_report>\n' +
            '<verdicts_json>\n' +
            '[{"findingId":"CAND-001","verdict":"CONFIRMED","rationale":"Reachable sink",' +
            '"evidence":["src/index.ts:1"],"verification":{"status":"verified","method":"static trace",' +
            '"observations":["Attacker input reaches the file read"]},"adjustedSeverity":"high"}]\n' +
            '</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('report-1', 'report_finding', confirmedFindingArgs('CAND-001'));
      }

      if (stage === 'reporter' && count === 2) {
        return toolCall('finish-1', 'finish_task', {summary: 'One confirmed finding reported.'});
      }

      return new AIMessage('# Security Audit Report\n\n## Path traversal\nConfirmed.');
    });
    const state = await compileWorkflow({
      model,
      repoMap: '- src/index.ts',
      systemPrompt: 'You are Shadow.',
      tools: tools(() => {
        sourceReportToolExecutions++;
        return {accepted: true};
      }),
    }).invoke(
      {
        auditRunId: 'audit-run-confirmed',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(state.pipelineFindings).to.have.length(1);
    expect(state.pipelineFindings[0]?.vulnId).to.equal('vuln-path-traversal');
    expect(state.pipelineFindings[0]?.locations).to.deep.include({
      filePath: 'src/index.ts',
      startLine: 2,
    });
    expect(state.verdicts).to.deep.include({
      adjustedSeverity: 'high',
      evidence: ['src/index.ts:1'],
      findingId: 'CAND-001',
      rationale: 'Reachable sink',
      verdict: 'CONFIRMED',
      verification: {
        evidenceArtifactIds: [],
        method: 'static trace',
        observations: ['Attacker input reaches the file read'],
        status: 'verified',
      },
    });
    expect(state.pipelineReport).to.include('## Path traversal');
    expect(sourceReportToolExecutions).to.equal(
      0,
      'the workflow must not mutate the external report sink before provenance validation',
    );
  });

  it('rejects an unknown report claim without mutating the external report sink', async () => {
    let sourceReportToolExecutions = 0;
    const stageCounts = new Map<string, number>();
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (stageCounts.get(stage) ?? 0) + 1;
      stageCounts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return toolCall('read-map-invalid', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/index.ts: request handler\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nInspected the request handler.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('read-invalid', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nOne candidate.\n</sast_report>\n' +
          '<sast_candidates_json>\n' +
          '[{"findingId":"CAND-001","title":"Path traversal","summary":"Input reaches a file sink",' +
          '"severity":"high","cwe":"CWE-22","confidence":0.95,"reachability":"verified",' +
          '"affectedLocations":[{"filePath":"src/index.ts","lineNumber":1}],' +
          '"sourceToSink":[{"kind":"source","location":{"filePath":"src/index.ts","lineNumber":1},' +
          '"description":"request path"},{"kind":"sink","location":{"filePath":"src/index.ts","lineNumber":2},' +
          '"description":"file read"}],"prerequisites":["Remote request access"],' +
          '"reproductionSteps":["Send a traversal path"],"proofOfConcept":{"kind":"payload",' +
          '"content":"../safe-fixture","safetyNotes":"Uses a local fixture only","executionStatus":"not_run"},' +
          '"impact":"Unauthorized file read",' +
          '"remediation":"Resolve and constrain paths to the trusted root","evidence":["src/index.ts:1"]}]\n' +
          '</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nCandidate confirmed.\n</adversarial_report>\n' +
          '<verdicts_json>\n' +
          '[{"findingId":"CAND-001","verdict":"CONFIRMED","rationale":"Reachable sink",' +
          '"evidence":["src/index.ts:1"],"verification":{"status":"verified","method":"static trace",' +
          '"observations":["Attacker input reaches the file read"]},"adjustedSeverity":"high"}]\n' +
          '</verdicts_json>',
        );
      }

      return toolCall(
        'report-invalid',
        'report_finding',
        confirmedFindingArgs('UNKNOWN-CLAIM'),
      );
    });
    const workflow = compileWorkflow({
      model,
      systemPrompt: 'You are Shadow.',
      tools: tools(() => {
        sourceReportToolExecutions++;
        return {accepted: true};
      }),
    });

    let error: unknown;
    try {
      await workflow.invoke(
        {
          auditRunId: 'audit-run-invalid-report',
          messages: [new HumanMessage('Audit this repository.')],
          mission: 'Audit this repository.',
        },
        {recursionLimit: WORKFLOW_RECURSION_LIMIT},
      );
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('CONFIRMED sourceClaimId');
    expect(sourceReportToolExecutions).to.equal(0);
  });

  it('resumes an interrupted stage by re-running its pending tool call', async () => {
    const stageCounts = new Map<string, number>();
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (stageCounts.get(stage) ?? 0) + 1;
      stageCounts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return toolCall('approval-read', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/index.ts: entry point\n</repo_map>\n' +
            '<codebase_report>\n# Architecture\nInspected `src/index.ts`.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('audit-read', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nNo candidates.\n</sast_report>\n' +
            '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates.\n</adversarial_report>\n' +
            '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('finish-resumed', 'finish_task', {summary: 'Audit complete.'});
      }

      return new AIMessage('# Security Audit Report\n\nNo confirmed findings.');
    });
    let readAttempts = 0;
    const resumableTools = tools().map((entry) => {
      if (entry.name !== 'read_file_content') return entry;
      return {
        ...entry,
        tool: {
          ...entry.tool,
          async execute({filePath}: {filePath: string}) {
            readAttempts++;
            if (readAttempts === 1) {
              return new Command({
                goto: ['HumanIntervention'],
                update: {
                  pendingHumanInput: {
                    context: filePath,
                    question: `Approve reading ${filePath}?`,
                    type: 'confirmation' as const,
                  },
                },
              });
            }

            return `source:${filePath}`;
          },
        },
      };
    });
    const workflow = compileWorkflow({
      checkpointer: new MemorySaver(),
      model,
      repoMap: '- src/index.ts',
      systemPrompt: 'You are Shadow.',
      tools: resumableTools,
    });
    const config = {
      configurable: {thread_id: 'pipeline-resume'},
      recursionLimit: WORKFLOW_RECURSION_LIMIT,
    };
    await workflow.invoke(
      {
        auditRunId: 'audit-run-resume',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      config,
    );
    const paused = await workflow.getState(config);
    expect(paused.next).to.include('HumanIntervention');
    expect(paused.values.pendingHumanInput?.question).to.equal(
      'Approve reading src/index.ts?',
    );

    await workflow.updateState(config, {pendingHumanInput: null}, 'HumanIntervention');
    const readyToResume = await workflow.getState(config);
    expect(readyToResume.next).to.include('CodebaseResumeTools');
    const resumed = await workflow.invoke(null, config);

    expect(readAttempts).to.equal(3);
    expect(resumed.pipelineReport).to.include('No confirmed findings.');
    expect(stageCounts.get('codebase')).to.equal(2);
  });

  it('fails closed when a stage returns a malformed handoff', async () => {
    let invocation = 0;
    const model = createModel(() => {
      invocation++;
      return invocation === 1
        ? toolCall('read-map', 'read_file_content', {filePath: 'src/index.ts'})
        : new AIMessage('Repository analysis without the required artifact tags.');
    });
    const workflow = compileWorkflow({
      model,
      systemPrompt: 'You are Shadow.',
      tools: tools(),
    });

    let error: unknown;
    try {
      await workflow.invoke(
        {
          auditRunId: 'audit-run-malformed',
          messages: [new HumanMessage('Audit this repository.')],
          mission: 'Audit this repository.',
        },
        {recursionLimit: WORKFLOW_RECURSION_LIMIT},
      );
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('<repo_map>');
  });

  it('enforces the reporting agent budget independently of larger stage budgets', async () => {
    let reporterInvocations = 0;
    const stageInvocations = new Map<string, number>();
    const candidates = Array.from({length: 9}, (_, index) => {
      const findingId = `CAND-${String(index + 1).padStart(3, '0')}`;
      return {
        affectedLocations: [{filePath: 'src/index.ts', lineNumber: 1}],
        confidence: 0.95,
        cwe: 'CWE-22',
        evidence: ['src/index.ts:1'],
        findingId,
        impact: 'Unauthorized file read',
        prerequisites: ['Remote request access'],
        proofOfConcept: {
          content: '../safe-fixture',
          executionStatus: 'not_run',
          kind: 'payload',
          safetyNotes: 'Static proof only',
        },
        reachability: 'likely',
        remediation: 'Constrain paths',
        reproductionSteps: ['Send a traversal path'],
        severity: 'high',
        sourceToSink: [
          {
            description: 'request path',
            kind: 'source',
            location: {filePath: 'src/index.ts', lineNumber: 1},
          },
          {
            description: 'file read',
            kind: 'sink',
            location: {filePath: 'src/index.ts', lineNumber: 2},
          },
        ],
        summary: 'Input reaches a file sink',
        title: 'Path traversal',
      };
    });
    const verdicts = candidates.map(({findingId}) => ({
      evidence: ['src/index.ts:1'],
      findingId,
      rationale: 'Reachable sink',
      verdict: 'CONFIRMED',
      verification: {
        method: 'static trace',
        observations: ['Input reaches the sink'],
        status: 'verified',
      },
    }));
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const stageInvocation = (stageInvocations.get(stage) ?? 0) + 1;
      stageInvocations.set(stage, stageInvocation);
      if (stage === 'codebase') {
        if (stageInvocation === 1) {
          return toolCall('inspect-codebase', 'read_file_content', {filePath: 'src/index.ts'});
        }

        return new AIMessage(
          '<repo_map>\n- src/index.ts: entry point\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nEntry point inspected.\n</codebase_report>',
        );
      }

      if (stage === 'sast') {
        if (stageInvocation === 1) {
          return toolCall('inspect-sast', 'read_file_content', {filePath: 'src/index.ts'});
        }

        return new AIMessage(
          '<sast_report>\n# SAST\nNo candidates.\n</sast_report>\n' +
          `<sast_candidates_json>\n${JSON.stringify(candidates)}\n</sast_candidates_json>`,
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nAll candidates confirmed.\n</adversarial_report>\n' +
          `<verdicts_json>\n${JSON.stringify(verdicts)}\n</verdicts_json>`,
        );
      }

      reporterInvocations++;
      const args = confirmedFindingArgs(
        `CAND-${String(reporterInvocations).padStart(3, '0')}`,
      );
      args.vulnId = `vuln-path-traversal-${reporterInvocations}`;
      return toolCall(
        `unexpected-finding-${reporterInvocations}`,
        'report_finding',
        args,
      );
    });
    const workflow = compileWorkflow({
      maxToolSteps: 1024,
      model,
      systemPrompt: 'You are Shadow.',
      toolPolicy: {
        agents: {
          reporting: {maxToolSteps: 8},
          sast_audit: {maxToolSteps: 1024},
        },
      },
      tools: tools(),
    });

    let error: unknown;
    try {
      await workflow.invoke(
        {
          auditRunId: 'audit-run-reporting-budget',
          messages: [new HumanMessage('Audit this repository.')],
          mission: 'Audit this repository.',
        },
        {recursionLimit: WORKFLOW_RECURSION_LIMIT},
      );
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include(
      'reporting exhausted its 8-step tool budget',
    );
    expect(reporterInvocations).to.equal(9);
  });

  it('repairs one malformed tool-free handoff without reopening tools', async () => {
    const counts = new Map<string, number>();
    let sawRepairInstruction = false;
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return toolCall('repair-read', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'codebase' && count === 2) {
        return new AIMessage('Malformed repository handoff.');
      }

      if (stage === 'codebase') {
        sawRepairInstruction = messages.some((message) =>
          String(message.content).includes('schema-repair attempt 1'),
        );
        return new AIMessage(
          '<repo_map>\n- src/index.ts\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nEntry point inspected.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('repair-sast-read', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nNo candidates.\n</sast_report>\n' +
          '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates.\n</adversarial_report>\n' +
          '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('finish-repair', 'finish_task', {summary: 'Audit complete.'});
      }

      return new AIMessage('# Security Audit Report\n\nNo confirmed findings.');
    });

    const state = await compileWorkflow({
      model,
      systemPrompt: 'You are Shadow.',
      tools: tools(),
    }).invoke(
      {
        auditRunId: 'audit-run-repair',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(sawRepairInstruction).to.equal(true);
    expect(state.codebaseIntelligence?.repoMap).to.include('src/index.ts');
    expect(state.pipelineReport).to.include('No confirmed findings.');
  });

  it('forces a tool-free SAST handoff after repeated tool calls', async () => {
    const counts = new Map<string, number>();
    let sawFinalizationInstruction = false;
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return toolCall('map-read', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/index.ts\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nEntry point inspected.\n</codebase_report>',
        );
      }

      if (stage === 'sast') {
        sawFinalizationInstruction ||= messages.some((message) =>
          String(message.content).includes('Tools are now unavailable'),
        );
        if (!sawFinalizationInstruction) {
          return toolCall(`repeat-${count}`, 'read_file_content', {filePath: 'src/index.ts'});
        }

        return new AIMessage(
          '<sast_report>\n# SAST\nNo evidence-backed candidates.\n</sast_report>\n' +
          '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates.\n</adversarial_report>\n' +
          '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('finish-repeated', 'finish_task', {summary: 'Audit complete.'});
      }

      return new AIMessage('# Security Audit Report\n\nNo confirmed findings.');
    });

    const state = await compileWorkflow({
      maxToolSteps: 12,
      model,
      systemPrompt: 'You are Shadow.',
      tools: tools(),
    }).invoke(
      {
        auditRunId: 'audit-run-repeated-sast',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(sawFinalizationInstruction).to.equal(true);
    expect(counts.get('sast')).to.equal(5);
    expect(state.pipelineReport).to.include('# Security Audit Report');
  });

  it('routes DeepSeek DSML through tools and preserves reasoning state across stages', async () => {
    const counts = new Map<string, number>();
    let sawDevilReasoningReplay = false;
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return new AIMessage(
          '<｜DSML｜tool_calls>' +
          '<｜DSML｜invoke name="read_file_content">' +
          '<｜DSML｜parameter name="filePath" string="true">src/index.ts</｜DSML｜parameter>' +
          '</｜DSML｜invoke>' +
          '</｜DSML｜tool_calls>',
        );
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/index.ts: entry point\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nInspected the entry point.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('read-audit-dsml', 'read_file_content', {filePath: 'src/index.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nNo evidence-backed candidates.\n</sast_report>\n' +
          '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil' && count === 1) {
        return new AIMessage({
          additional_kwargs: {reasoning_content: 'opaque DeepSeek continuation state'},
          content:
            '<｜｜DSML｜｜tool_calls>' +
            '<｜｜DSML｜｜invoke name="read_file_content">' +
            '<｜｜DSML｜｜parameter name="filePath" string="true">src/index.ts</｜｜DSML｜｜parameter>' +
            '</｜｜DSML｜｜invoke>' +
            '</｜｜DSML｜｜tool_calls>',
        });
      }

      if (stage === 'devil') {
        sawDevilReasoningReplay = messages.some((message) =>
          AIMessage.isInstance(message) &&
          message.additional_kwargs.reasoning_content === 'opaque DeepSeek continuation state',
        );
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates required review.\n</adversarial_report>\n' +
          '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return new AIMessage(
          '<｜｜DSML｜｜tool_calls>' +
          '<｜｜DSML｜｜invoke name="finish_task">' +
          '<｜｜DSML｜｜parameter name="summary" string="true">Audit complete.</｜｜DSML｜｜parameter>' +
          '</｜｜DSML｜｜invoke>' +
          '</｜｜DSML｜｜tool_calls>',
        );
      }

      return new AIMessage('# Security Audit Report\n\nNo confirmed findings.');
    });

    const state = await compileWorkflow({
      model,
      providerHint: 'deepseek',
      repoMap: '- src/index.ts',
      systemPrompt: 'You are Shadow.',
      tools: tools(),
    }).invoke(
      {
        auditRunId: 'audit-run-deepseek-dsml',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(sawDevilReasoningReplay).to.equal(true);
    expect(counts.get('devil')).to.equal(2);
    expect(counts.get('reporter')).to.equal(2);
    expect(state.pipelineReport).to.include('# Security Audit Report');
  });

  it('does not count error-shaped tool output as successful stage evidence', async () => {
    let invocation = 0;
    const model = createModel(() => {
      invocation++;
      if (invocation === 1) {
        return toolCall('failed-read', 'read_file_content', {filePath: 'src/index.ts'});
      }

      return new AIMessage(
        '<repo_map>\n- src/index.ts\n</repo_map>\n' +
        '<codebase_report>\n# Architecture\nInspection claimed.\n</codebase_report>',
      );
    });
    const failingTools = tools();
    failingTools[0]!.tool.execute = async () =>
      '[ERROR] Could not read file "src/index.ts": permission denied.';
    let error: unknown;

    try {
      await compileWorkflow({
        model,
        systemPrompt: 'You are Shadow.',
        tools: failingTools,
      }).invoke(
        {
          auditRunId: 'audit-run-failed-evidence',
          messages: [new HumanMessage('Audit this repository.')],
          mission: 'Audit this repository.',
        },
        {recursionLimit: WORKFLOW_RECURSION_LIMIT},
      );
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('without successfully inspecting evidence');
  });

  it('accepts large parallel batches for every investigation specialist', async () => {
    let executions = 0;
    const stageCalls = new Map<string, number>();
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const stageCall = (stageCalls.get(stage) ?? 0) + 1;
      stageCalls.set(stage, stageCall);
      if (stage !== 'reporter' && stageCall === 1) {
        return new AIMessage({
          content: '',
          tool_calls: Array.from({length: 26}, (_, index) => ({
            args: {filePath: `src/${stage}-${index}.ts`},
            id: `read-${stage}-${index}`,
            name: 'read_file_content',
            type: 'tool_call' as const,
          })),
        });
      }

      if (stage === 'codebase') {
        return new AIMessage(
          '<repo_map>\n- src/: source files\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nRepository inspected.\n</codebase_report>',
        );
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nNo candidates.\n</sast_report>\n' +
          '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates.\n</adversarial_report>\n' +
          '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && !messages.some((message) => ToolMessage.isInstance(message))) {
        return toolCall('finish-batch', 'finish_task', {summary: 'Audit complete.'});
      }

      return new AIMessage('# Security Audit Report\n\nNo confirmed vulnerabilities.');
    });
    const countedTools = tools();
    countedTools[0]!.tool.execute = async () => {
      executions++;
      return 'source';
    };

    await compileWorkflow({
      maxToolSteps: 1,
      model,
      systemPrompt: 'You are Shadow.',
      tools: countedTools,
    }).invoke(
      {
        auditRunId: 'audit-run-tool-batch-limit',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(executions).to.equal(78);
  });

  it('bounds parallel repository reads and preserves model-issued result order', async () => {
    const counts = new Map<string, number>();
    let active = 0;
    let maxActive = 0;
    let codebaseResults: Array<{
      content: string;
      securityBoundary: {classification: string; sourceTool: string};
    }> = [];
    const model = createModel((messages) => {
      const stage = stageFromSystem(String(messages[0]?.content ?? ''));
      const count = (counts.get(stage) ?? 0) + 1;
      counts.set(stage, count);

      if (stage === 'codebase' && count === 1) {
        return new AIMessage({
          content: '',
          tool_calls: Array.from({length: 5}, (_, index) => ({
            args: {filePath: `src/${index + 1}.ts`},
            id: `read-${index + 1}`,
            name: 'read_file_content',
            type: 'tool_call' as const,
          })),
        });
      }

      if (stage === 'codebase') {
        codebaseResults = messages
          .filter((message) => ToolMessage.isInstance(message))
          .slice(-5)
          .map((message) => JSON.parse(String(message.content)) as {
            content: string;
            securityBoundary: {classification: string; sourceTool: string};
          });
        return new AIMessage(
          '<repo_map>\n- src/: source files\n</repo_map>\n' +
          '<codebase_report>\n# Architecture\nFive files inspected.\n</codebase_report>',
        );
      }

      if (stage === 'sast' && count === 1) {
        return toolCall('read-bounded-sast', 'read_file_content', {filePath: 'src/1.ts'});
      }

      if (stage === 'sast') {
        return new AIMessage(
          '<sast_report>\n# SAST\nNo candidates.\n</sast_report>\n' +
          '<sast_candidates_json>\n[]\n</sast_candidates_json>',
        );
      }

      if (stage === 'devil') {
        return new AIMessage(
          '<adversarial_report>\n# Validation\nNo candidates.\n</adversarial_report>\n' +
          '<verdicts_json>\n[]\n</verdicts_json>',
        );
      }

      if (stage === 'reporter' && count === 1) {
        return toolCall('finish-bounded', 'finish_task', {summary: 'Audit complete.'});
      }

      return new AIMessage('# Security Audit Report\n\nNo confirmed vulnerabilities.');
    });
    const boundedTools = tools();
    boundedTools[0]!.tool.execute = async ({filePath}: {filePath: string}) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, filePath === 'src/1.ts' ? 30 : 5);
      });
      active--;
      return `source:${filePath}`;
    };

    await compileWorkflow({
      model,
      systemPrompt: 'You are Shadow.',
      tools: boundedTools,
    }).invoke(
      {
        auditRunId: 'audit-run-bounded-reads',
        messages: [new HumanMessage('Audit this repository.')],
        mission: 'Audit this repository.',
      },
      {recursionLimit: WORKFLOW_RECURSION_LIMIT},
    );

    expect(maxActive).to.equal(5);
    expect(codebaseResults.map((result) => result.content)).to.deep.equal([
      'source:src/1.ts',
      'source:src/2.ts',
      'source:src/3.ts',
      'source:src/4.ts',
      'source:src/5.ts',
    ]);
    expect(codebaseResults.every((result) =>
      result.securityBoundary.classification === 'untrusted_repository_evidence' &&
      result.securityBoundary.sourceTool === 'read_file_content',
    )).to.equal(true);
  });
});

function createModel(
  invoke: (messages: BaseMessage[]) => AIMessage,
  onBindTools?: (names: string[]) => void,
): BaseChatModel {
  return {
    bindTools(boundTools: Array<{name: string}>) {
      onBindTools?.(boundTools.map((boundTool) => boundTool.name));
      return {invoke};
    },
    invoke,
  } as unknown as BaseChatModel;
}

function stageFromSystem(system: string): string {
  if (system.includes('Codebase Intelligence Agent')) return 'codebase';
  if (system.includes("Shadow's SAST Auditor")) return 'sast';
  if (system.includes("Shadow's Devil's Advocate")) return 'devil';
  if (system.includes("Shadow's Reporting Agent")) return 'reporter';
  throw new Error(`Unknown stage prompt: ${system.slice(0, 80)}`);
}

function toolCall(id: string, name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{args, id, name, type: 'tool_call'}],
  });
}

function confirmedFindingArgs(sourceClaimId: string): Record<string, unknown> {
  return {
    attackerPersonas: ['unauthenticated_remote'],
    confidence: 0.95,
    cvssV31Score: 7.5,
    cvssV31Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
    cwe: 'CWE-22',
    dataFlowPath: [
      {
        description: 'request path',
        isSource: true,
        location: {filePath: 'src/index.ts', startLine: 1},
      },
      {
        description: 'file read',
        isSink: true,
        location: {filePath: 'src/index.ts', startLine: 2},
      },
    ],
    exploitability: 'easy',
    locations: [{filePath: 'src/index.ts', startLine: 1}],
    remediation: {summary: 'Resolve and constrain paths beneath the repository root.'},
    rootCause: 'An attacker-controlled path reaches a file read without containment.',
    severityLabel: 'High',
    sourceClaimId,
    title: 'Path traversal',
    vulnId: 'vuln-path-traversal',
  };
}

function tools(
  executeReportFinding: () => {accepted: boolean} = () => ({accepted: true}),
): ToolEntry[] {
  return [
    {
      name: 'read_file_content',
      tool: {
        description: 'Read a source file.',
        execute: async ({filePath}: {filePath: string}) => `source:${filePath}`,
        inputSchema: z.object({filePath: z.string()}),
      },
    },
    {
      name: 'report_finding',
      tool: {
        description: 'Record a finding.',
        execute: executeReportFinding,
        inputSchema: z.object({sourceClaimId: z.string()}).passthrough(),
      },
    },
    {
      name: 'finish_task',
      tool: {
        description: 'Finish the audit.',
        execute: async ({summary}: {summary: string}) => summary,
        inputSchema: z.object({summary: z.string()}),
      },
    },
  ] as ToolEntry[];
}

function mutationTool(name: string): ToolEntry {
  return {
    name,
    tool: {
      description: 'Apply a patch to the repository.',
      async execute() {
        throw new Error('Mutation tool must not execute during investigation.');
      },
      inputSchema: z.object({diff: z.string(), findingId: z.string()}),
    },
  } as ToolEntry;
}

function investigationTool(name: string): ToolEntry {
  return {
    name,
    tool: {
      description: 'Inspect the repository with a host command.',
      async execute() {
        return 'command output';
      },
      inputSchema: z.object({command: z.string()}),
    },
  } as ToolEntry;
}
