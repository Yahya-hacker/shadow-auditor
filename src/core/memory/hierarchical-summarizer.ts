/**
 * Hierarchical Summarizer - Generates LLM summaries for knowledge graph communities.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { HumanMessage } from '@langchain/core/messages';

import type { BaseEntity, CommunitySummary } from './memory-schema.js';

export interface HierarchicalSummarizerOptions {
  model: BaseChatModel;
}

export class HierarchicalSummarizer {
  private readonly model: BaseChatModel;

  constructor(options: HierarchicalSummarizerOptions) {
    this.model = options.model;
  }

  /**
   * Summarize a single community.
   */
  async summarizeCommunity(
    communityId: string,
    entities: BaseEntity[],
  ): Promise<CommunitySummary> {
    const labels = entities.map((e) => `${e.entityType}: ${e.label}`).join('\n');
    const prompt = `You are a senior security architect. Summarize the following code community in one concise sentence. Focus on its security-relevant purpose (e.g., authentication, input validation, database access).

Community entities:
${labels}

Summary:`;

    const response = await this.model.invoke([new HumanMessage({ content: prompt })]);
    const summary = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

    return {
      communityId,
      generatedAt: new Date().toISOString(),
      summary: summary.trim() || `Community ${communityId}`,
    };
  }
}
