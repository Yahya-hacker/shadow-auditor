import { expect } from 'chai';

import {
  CODEBASE_INTELLIGENCE_PROMPT,
  DEVILS_ADVOCATE_PROMPT,
  SAST_AUDITOR_PROMPT,
} from '../src/core/graph/pipeline-prompts.js';

describe('pipeline stage prompts', () => {
  it('loads the supplied Codebase Intelligence prompt and runtime contract', () => {
    expect(CODEBASE_INTELLIGENCE_PROMPT).to.include('Full Repository Ingestion');
    expect(CODEBASE_INTELLIGENCE_PROMPT).to.include('<repo_map>');
    expect(CODEBASE_INTELLIGENCE_PROMPT).to.include('never reveal private chain-of-thought');
  });

  it('loads the supplied SAST prompt and runtime contract', () => {
    expect(SAST_AUDITOR_PROMPT).to.include('Anti-Hallucination Protocol');
    expect(SAST_AUDITOR_PROMPT).to.include('<sast_candidates_json>');
    expect(SAST_AUDITOR_PROMPT).to.include('never reveal private chain-of-thought');
    expect(SAST_AUDITOR_PROMPT).not.to.match(/externalize (?:your )?full reasoning/iu);
  });

  it("loads the supplied Devil's Advocate prompt and runtime contract", () => {
    expect(DEVILS_ADVOCATE_PROMPT).to.include('How to Evaluate Each Finding');
    expect(DEVILS_ADVOCATE_PROMPT).to.include('<verdicts_json>');
    expect(DEVILS_ADVOCATE_PROMPT).to.include('never reveal private chain-of-thought');
    expect(DEVILS_ADVOCATE_PROMPT).to.include('Missing decisive evidence produces an UNVERIFIABLE verdict');
  });
});
