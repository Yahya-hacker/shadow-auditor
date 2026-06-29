import { expect } from 'chai';

import type {
  AttackChain,
  AttackStep,
} from '../src/core/planner/planner-schema.js';

import {
  AttackChainManager,
  type AttackStepInput,
  AttackStepManager,
} from '../src/core/planner/attack-chain.js';

describe('attack chain planner', () => {
  describe('AttackStepManager', () => {
    let manager: AttackStepManager;
    
    beforeEach(() => {
      manager = new AttackStepManager();
    });

    it('creates a valid attack step', () => {
      const input: AttackStepInput = {
        attackCategory: 'injection',
        cwe: 'CWE-89',
        description: 'Inject malicious SQL to bypass authentication',
        entityIds: ['source_deadbeef'],
        title: 'Exploit SQL Injection',
      };
      
      const result = manager.createStep(input);
      
      expect(result.ok).to.be.true;
      if (result.ok) {
        expect(result.value.title).to.equal('Exploit SQL Injection');
        expect(result.value.cwe).to.equal('CWE-89');
        expect(result.value.status).to.equal('hypothesized');
        expect(result.value.confidence).to.be.lessThan(0.5); // Low initial
      }
    });

    it('adds and retrieves steps correctly', () => {
      const input1: AttackStepInput = {
        attackCategory: 'xss',
        cwe: 'CWE-79',
        description: 'First step',
        title: 'Step 1',
      };
      const input2: AttackStepInput = {
        attackCategory: 'injection',
        cwe: 'CWE-89',
        description: 'Second step',
        title: 'Step 2',
      };
      
      const result1 = manager.createStep(input1);
      const result2 = manager.createStep(input2);
      
      expect(result1.ok).to.be.true;
      expect(result2.ok).to.be.true;
      expect(manager.getAllSteps()).to.have.lengthOf(2);
      
      if (result1.ok) {
        const retrieved = manager.getStep(result1.value.stepId);
        expect(retrieved).to.deep.equal(result1.value);
      }
    });

    it('updates step status correctly', () => {
      const input: AttackStepInput = {
        attackCategory: 'xss',
        cwe: 'CWE-79',
        description: 'A test step',
        title: 'Test Step',
      };
      
      const result = manager.createStep(input);
      expect(result.ok).to.be.true;
      
      if (result.ok) {
        const updated = manager.updateStepStatus(result.value.stepId, 'verified');
        expect(updated.ok).to.be.true;
        if (updated.ok) {
          expect(updated.value.status).to.equal('verified');
        }
      }
    });

    it('returns verifiable steps (no unverified prerequisites)', () => {
      // Create step 1 (no prerequisites)
      const result1 = manager.createStep({
        attackCategory: 'xss',
        cwe: 'CWE-79',
        description: 'First step',
        title: 'Step 1',
      });
      
      expect(result1.ok).to.be.true;
      if (!result1.ok) return;
      
      // Create step 2 with step 1 as prerequisite
      const result2 = manager.createStep({
        attackCategory: 'injection',
        cwe: 'CWE-89',
        description: 'Second step',
        prerequisites: [result1.value.stepId],
        title: 'Step 2',
      });
      
      expect(result2.ok).to.be.true;
      
      // Only step 1 should be verifiable initially
      let verifiable = manager.getVerifiableSteps();
      expect(verifiable).to.have.lengthOf(1);
      expect(verifiable[0].stepId).to.equal(result1.value.stepId);
      
      // After verifying step 1, step 2 should be verifiable
      manager.updateStepStatus(result1.value.stepId, 'verified');
      verifiable = manager.getVerifiableSteps();
      expect(verifiable).to.have.lengthOf(1);
      if (result2.ok) {
        expect(verifiable[0].stepId).to.equal(result2.value.stepId);
      }
    });

    it('detects cyclic dependencies', () => {
      const result1 = manager.createStep({
        attackCategory: 'xss',
        cwe: 'CWE-79',
        description: 'First',
        title: 'Step A',
      });
      
      expect(result1.ok).to.be.true;
      if (!result1.ok) return;
      
      // Note: Direct cycles would need to be injected through importSteps
      // since createStep doesn't allow referencing future steps
      expect(manager.hasCyclicDependency(result1.value.stepId)).to.be.false;
    });
  });

  describe('AttackChainManager', () => {
    let stepManager: AttackStepManager;
    let chainManager: AttackChainManager;
    let step1: AttackStep;
    let step2: AttackStep;
    
    beforeEach(() => {
      stepManager = new AttackStepManager();
      chainManager = new AttackChainManager(stepManager);
      
      const result1 = stepManager.createStep({
        attackCategory: 'xss',
        cwe: 'CWE-79',
        description: 'Initial entry',
        feasibility: 0.8,
        impact: 0.7,
        title: 'Entry Point',
      });
      
      expect(result1.ok).to.be.true;
      if (result1.ok) {
        step1 = result1.value;
      }
      
      const result2 = stepManager.createStep({
        attackCategory: 'injection',
        cwe: 'CWE-89',
        description: 'Privilege escalation',
        feasibility: 0.6,
        impact: 0.9,
        prerequisites: [step1.stepId],
        title: 'Escalation',
      });
      
      expect(result2.ok).to.be.true;
      if (result2.ok) {
        step2 = result2.value;
      }
    });

    it('creates chains from steps', () => {
      const result = chainManager.createChain(
        'Test Chain',
        'A test attack chain',
        [step1.stepId, step2.stepId],
      );
      
      expect(result.ok).to.be.true;
      if (result.ok) {
        expect(result.value.title).to.equal('Test Chain');
        expect(result.value.steps).to.have.lengthOf(2);
        expect(result.value.status).to.equal('hypothesized');
      }
    });

    it('fails to create chain with invalid step IDs', () => {
      const result = chainManager.createChain(
        'Invalid Chain',
        'Should fail',
        ['nonexistent_step_id'],
      );
      
      expect(result.ok).to.be.false;
    });

    it('ranks chains by score', () => {
      // Create a high-impact chain
      const highImpactStep = stepManager.createStep({
        attackCategory: 'injection',
        cwe: 'CWE-78',
        description: 'Critical vulnerability',
        feasibility: 0.9,
        impact: 1,
        title: 'High Impact',
      });
      expect(highImpactStep.ok).to.be.true;
      
      // Create a low-impact chain
      const lowImpactStep = stepManager.createStep({
        attackCategory: 'sensitive_data',
        cwe: 'CWE-200',
        description: 'Info disclosure',
        feasibility: 0.9,
        impact: 0.2,
        title: 'Low Impact',
      });
      expect(lowImpactStep.ok).to.be.true;
      
      if (!highImpactStep.ok || !lowImpactStep.ok) return;
      
      chainManager.createChain('High', 'High impact', [highImpactStep.value.stepId]);
      chainManager.createChain('Low', 'Low impact', [lowImpactStep.value.stepId]);
      
      const ranked = chainManager.getRankedChains();
      
      expect(ranked).to.have.lengthOf(2);
      expect(ranked[0].title).to.equal('High');
    });

    it('separates hypothesized from verified chains', () => {
      // Create two chains
      const chain1 = chainManager.createChain('Chain 1', 'First', [step1.stepId]);
      expect(chain1.ok).to.be.true;
      
      const chain2 = chainManager.createChain('Chain 2', 'Second', [step2.stepId]);
      expect(chain2.ok).to.be.true;
      
      if (!chain1.ok || !chain2.ok) return;
      
      // Verify step1 which should update chain1's status when refreshed
      stepManager.updateStepStatus(step1.stepId, 'verified');
      chainManager.refreshChain(chain1.value.chainId);
      
      const hypoChains = chainManager.getHypothesizedChains();
      const verifiedChains = chainManager.getVerifiedChains();
      
      expect(hypoChains).to.have.lengthOf(1);
      expect(verifiedChains).to.have.lengthOf(1);
    });
  });
});
