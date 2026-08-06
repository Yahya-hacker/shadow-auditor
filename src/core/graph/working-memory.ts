import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import { AgentState } from './state.js';

type GraphState = typeof AgentState.State;

const FILE_PATTERN = /(?:`|['"]|\b)([\w./-]+\.(?:ts|tsx|js|jsx|py|go|java|rs|php|rb|c|h|cpp|cxx|hpp|vue|svelte|swift|kt|kts|cs|fs|fsx|sql|yaml|yml|json|xml|toml|cfg|ini|env|dockerfile|makefile)(?:`|['"]|\b))/gi;
const FILE_MARKER_PATTERN = /(?:File:|📄|📁|FILE:)\s*([^\s,\n]+)/gi;

export function summarizeDroppedMessages(
  messages: BaseMessage[],
  auditedFiles: string[] = [],
): string {
  const findings: string[] = [];
  const filesExamined = new Set(auditedFiles);
  const toolCalls: string[] = [];

  for (const message of messages) {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    for (const file of extractFileReferences(content)) filesExamined.add(file);

    if (isFindingContent(content)) {
      findings.push(`- ${content.replaceAll('\n', ' ').slice(0, 200).trim()}...`);
    }

    if (message instanceof AIMessage && message.tool_calls?.length) {
      toolCalls.push(...message.tool_calls.map((call) => call.name));
    }
  }

  const parts: string[] = [];
  if (filesExamined.size > 0) {
    const files = [...filesExamined];
    parts.push(
      `Files examined: ${files.slice(0, 15).join(', ')}${
        files.length > 15 ? ` (+${files.length - 15} more)` : ''
      }`,
    );
  }

  if (findings.length > 0) {
    parts.push(
      `Key findings/hypotheses:\n${findings.slice(0, 5).join('\n')}${
        findings.length > 5 ? `\n(+${findings.length - 5} more)` : ''
      }`,
    );
  }

  if (toolCalls.length > 0) {
    parts.push(`Tools used: ${[...new Set(toolCalls)].join(', ')} (${toolCalls.length} total calls)`);
  }

  return parts.join('\n\n') || '(No significant findings in trimmed context)';
}

export function updateWorkingMemory(
  state: GraphState,
  newMessage: BaseMessage,
): { auditedFiles: string[]; discoveredFindings: string[]; memory: string } {
  const content = typeof newMessage.content === 'string'
    ? newMessage.content
    : JSON.stringify(newMessage.content);
  const hitMatches = content.match(/\[Hit\][^\n]*/g) ?? [];
  const alertMatches = content.match(/\[Alert\][^\n]*/g) ?? [];
  const cweMatches = content.match(/CWE-\d{1,4}[^\n]*/g) ?? [];
  const entries: string[] = [];
  const findings = [...hitMatches, ...alertMatches].map((entry) => entry.trim());
  const auditedFiles = extractFileReferences(content);
  let memory = state.workingMemory || '';

  if (hitMatches.length > 0) entries.push(`Findings: ${hitMatches.map((entry) => entry.trim()).join('; ')}`);
  if (alertMatches.length > 0) entries.push(`Alerts: ${alertMatches.map((entry) => entry.trim()).join('; ')}`);
  if (cweMatches.length > 0 && hitMatches.length === 0) {
    entries.push(`CWE references: ${[...new Set(cweMatches)].join(', ')}`);
    findings.push(...cweMatches);
  }

  if (auditedFiles.length > 0 && !memory.includes('Files examined:')) {
    entries.push(`Files referenced: ${auditedFiles.slice(0, 10).join(', ')}`);
  }

  if (entries.length > 0) {
    const next = `[${new Date().toLocaleTimeString()}] ${entries.join(' | ')}`;
    memory = memory ? `${memory}\n${next}` : next;
  }

  if (memory.length > 2000) memory = memory.split('\n').slice(-15).join('\n');

  return { auditedFiles, discoveredFindings: findings, memory };
}

function extractFileReferences(content: string): string[] {
  const files = new Set(
    (content.match(FILE_PATTERN) ?? [])
      .map((file) => file.replaceAll(/[`'"]/g, '').trim())
      .filter((file) => file.length > 2 && file.length < 200),
  );
  for (const match of content.matchAll(FILE_MARKER_PATTERN)) {
    const file = match[1]?.replaceAll(/[`'"]/g, '').trim();
    if (file && file.length > 2 && file.length < 200) files.add(file);
  }

  return [...files];
}

function isFindingContent(content: string): boolean {
  return ['[Hit]', '[Alert]', 'vulnerability', 'CWE-', 'finding', 'injection']
    .some((marker) => content.includes(marker));
}
