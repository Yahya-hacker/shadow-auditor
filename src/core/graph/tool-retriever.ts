/**
 * Tool Retriever - Dynamic, top-K tool selection for LangGraph workflows.
 *
 * Instead of binding every tool to the LLM (which causes "tool blindness" as the
 * context grows), this retriever scores tools against the current conversation
 * and returns only the most relevant ones for the current step.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { ToolSet } from 'ai';

export interface ToolEntry {
  name: string;
  tool: ToolSet[string];
}

export interface ToolRetrieverOptions {
  /**
   * Optional embedding provider for semantic similarity. If omitted, a
   * lightweight keyword-overlap scorer is used.
   */
  embedProvider?: {
    embed(texts: string[]): Promise<number[][]>;
  };
  /**
   * Maximum number of tools to return. If the conversation is empty or the
   * retriever cannot score tools, it falls back to all tools.
   */
  topK?: number;
}

interface ScoredTool {
  entry: ToolEntry;
  score: number;
}

export class ToolRetriever {
  private readonly allTools: ToolEntry[];
  private readonly embedProvider?: ToolRetrieverOptions['embedProvider'];
  private readonly topK: number;

  constructor(tools: ToolEntry[], options: ToolRetrieverOptions = {}) {
    this.allTools = tools;
    this.topK = options.topK ?? 5;
    this.embedProvider = options.embedProvider;
  }

  /**
   * Return the top-K most relevant tools for the given conversation context.
   * Falls back to all tools when no context is available.
   */
  async retrieve(messages: BaseMessage[]): Promise<ToolEntry[]> {
    if (this.allTools.length === 0) {
      return [];
    }

    if (this.allTools.length <= this.topK) {
      return this.allTools;
    }

    const context = this.extractContext(messages);
    if (!context) {
      return this.allTools;
    }

    if (this.embedProvider) {
      return this.embeddedRetrieve(context);
    }

    return this.keywordRetrieve(context);
  }

  private async embeddedRetrieve(context: string): Promise<ToolEntry[]> {
    if (!this.embedProvider) {
      return this.allTools;
    }

    const toolDescriptions = this.allTools.map((t) => this.toolDescription(t));
    const texts = [context, ...toolDescriptions];
    const embeddings = await this.embedProvider.embed(texts);
    const contextVector = embeddings[0];
    const toolVectors = embeddings.slice(1);

    const scored: ScoredTool[] = this.allTools.map((entry, index) => ({
      entry,
      score: cosineSimilarity(contextVector, toolVectors[index]!),
    }));

    return this.selectTop(scored);
  }

  private extractContext(messages: BaseMessage[]): string {
    // Use the last few human/assistant messages as the query context.
    const recent = messages.slice(-6);
    return recent
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
      .toLowerCase();
  }

  private keywordRetrieve(context: string): ToolEntry[] {
    const terms = tokenize(context);
    if (terms.length === 0) {
      return this.allTools;
    }

    const scored: ScoredTool[] = this.allTools.map((entry) => {
      const description = this.toolDescription(entry).toLowerCase();
      const descriptionTokens = new Set(tokenize(description));
      let matches = 0;
      for (const term of terms) {
        if (descriptionTokens.has(term)) {
          matches++;
        }
      }

      // Bonus for name overlap
      const nameTokens = new Set(tokenize(entry.name.toLowerCase()));
      for (const term of terms) {
        if (nameTokens.has(term)) {
          matches += 2;
        }
      }

      return { entry, score: matches };
    });

    return this.selectTop(scored);
  }

  private selectTop(scored: ScoredTool[]): ToolEntry[] {
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, this.topK).map((s) => s.entry);

    // Always include critical lifecycle tools regardless of keyword score.
    // Without finish_task, the agent cannot self-terminate. Without
    // context_retrieval, it cannot efficiently search the codebase.
    const essentialNames = new Set(['finish_task', 'context_retrieval']);
    for (const entry of this.allTools) {
      if (essentialNames.has(entry.name) && !top.some((t) => t.name === entry.name)) {
        top.push(entry);
      }
    }

    return top;
  }

  private toolDescription(entry: ToolEntry): string {
    const raw = (entry.tool as { description?: string }).description;
    return typeof raw === 'string' ? raw : entry.name;
  }
}

function tokenize(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [i, element] of a.entries()) {
    dot += element! * b[i]!;
    normA += element! * element!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
