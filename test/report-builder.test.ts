import { expect } from 'chai';
import { readFile } from 'node:fs/promises';

import { ReportBuilder } from '../src/core/output/report-builder.js';

describe('report builder', () => {
  it('defaults toolVersion to the installed package version instead of a stale constant', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const report = new ReportBuilder({ outputDir: 'unused', runId: 'run-version' }).build();

    expect(report.metadata.toolVersion).to.equal(packageJson.version);
    expect(report.metadata.toolVersion).to.match(/^\d+\.\d+\.\d+/);
  });

  it('honours an explicit toolVersion override', () => {
    const report = new ReportBuilder({
      outputDir: 'unused',
      runId: 'run-version',
      toolVersion: '9.9.9-test',
    }).build();

    expect(report.metadata.toolVersion).to.equal('9.9.9-test');
  });
});