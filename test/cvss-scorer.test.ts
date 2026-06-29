import { expect } from 'chai';

import {
  checkCvssConsistency,
  computeCvssBaseScore,
  cvssScoreToSeverityLabel,
  parseCvssVector,
  scoreCvssVector,
} from '../src/core/output/cvss-scorer.js';

describe('cvss-scorer', () => {
  describe('parseCvssVector', () => {
    it('parses a valid CVSS v3.1 vector', () => {
      const result = parseCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
      expect(result.valid).to.be.true;
      expect(result.metrics?.AV).to.equal('N');
      expect(result.metrics?.C).to.equal('H');
    });

    it('rejects a vector that does not start with CVSS:3.1/', () => {
      const result = parseCvssVector('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
      expect(result.valid).to.be.false;
      expect(result.error).to.include('CVSS:3.1/');
    });

    it('rejects a vector with an unknown metric value', () => {
      const result = parseCvssVector('CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
      expect(result.valid).to.be.false;
    });

    it('rejects a vector missing a required metric', () => {
      // Missing A (Availability)
      const result = parseCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H');
      expect(result.valid).to.be.false;
      expect(result.error).to.include('"A"');
    });

    it('accepts a vector with extra temporal/environmental metrics', () => {
      const result = parseCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O');
      expect(result.valid).to.be.true;
    });
  });

  describe('computeCvssBaseScore', () => {
    it('computes 9.8 for a typical critical unauthenticated RCE vector', () => {
      const parsed = parseCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
      expect(parsed.valid).to.be.true;
      const score = computeCvssBaseScore(parsed.metrics!);
      expect(score).to.be.closeTo(9.8, 0.1);
    });

    it('computes 0 when all impact metrics are None', () => {
      const parsed = parseCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N');
      expect(parsed.valid).to.be.true;
      const score = computeCvssBaseScore(parsed.metrics!);
      expect(score).to.equal(0);
    });
  });

  describe('cvssScoreToSeverityLabel', () => {
    it('labels 9.0+ as Critical', () => {
      expect(cvssScoreToSeverityLabel(9)).to.equal('Critical');
      expect(cvssScoreToSeverityLabel(10)).to.equal('Critical');
    });

    it('labels 7.0–8.9 as High', () => {
      expect(cvssScoreToSeverityLabel(7)).to.equal('High');
      expect(cvssScoreToSeverityLabel(8.9)).to.equal('High');
    });

    it('labels 4.0–6.9 as Medium', () => {
      expect(cvssScoreToSeverityLabel(4)).to.equal('Medium');
      expect(cvssScoreToSeverityLabel(6.9)).to.equal('Medium');
    });

    it('labels 0.1–3.9 as Low', () => {
      expect(cvssScoreToSeverityLabel(0.1)).to.equal('Low');
      expect(cvssScoreToSeverityLabel(3.9)).to.equal('Low');
    });

    it('labels 0.0 as Info', () => {
      expect(cvssScoreToSeverityLabel(0)).to.equal('Info');
    });
  });

  describe('scoreCvssVector', () => {
    it('returns computed score and severity label for a valid vector', () => {
      const result = scoreCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
      expect(result).to.not.be.null;
      expect(result!.baseScore).to.be.greaterThan(0);
      expect(result!.severityLabel).to.equal('Critical');
    });

    it('returns null for an invalid vector', () => {
      const result = scoreCvssVector('NOT_A_VECTOR');
      expect(result).to.be.null;
    });
  });

  describe('checkCvssConsistency', () => {
    it('reports consistent when reported score matches computed', () => {
      const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
      const computed = scoreCvssVector(vector)!.baseScore;
      const result = checkCvssConsistency(computed, vector);
      expect(result.isConsistent).to.be.true;
    });

    it('reports inconsistent when scores differ beyond tolerance', () => {
      const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
      const result = checkCvssConsistency(2, vector); // Far off
      expect(result.isConsistent).to.be.false;
      expect(result.correctedScore).to.be.a('number');
    });

    it('reports inconsistent for an invalid vector', () => {
      const result = checkCvssConsistency(7.5, 'INVALID_VECTOR');
      expect(result.isConsistent).to.be.false;
    });

    it('accepts scores within custom tolerance', () => {
      const vector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
      const computed = scoreCvssVector(vector)!.baseScore;
      // Offset by exactly within the tolerance
      const result = checkCvssConsistency(computed - 0.4, vector, 0.5);
      expect(result.isConsistent).to.be.true;
    });
  });
});
