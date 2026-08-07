import {expect} from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  digestCanonicalJson,
  type JsonValue,
  sha256Bytes,
} from '../src/protocol/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('protocol manifest', () => {
  it('verifies every digest with platform-independent LF semantics', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'protocol', 'manifest.json'), 'utf8'),
    ) as {
      fileDigestSemantics: string;
      files: Array<{bytes: number; path: string; sha256: string}>;
      protocolDigest: string;
      protocolDigestSemantics: string;
    };
    expect(manifest.fileDigestSemantics).to.equal(
      'SHA-256 over UTF-8 text after CRLF and CR normalization to LF; manifest.json is excluded to avoid self-reference.',
    );
    expect(manifest.files.map((file) => file.path)).to.deep.equal(
      manifest.files.map((file) => file.path).sort(),
    );
    for (const file of manifest.files) {
      const source = fs.readFileSync(path.join(root, file.path), 'utf8');
      const normalized = source.replaceAll(/\r\n?/g, '\n');
      const simulatedCrLfCheckout = normalized.replaceAll('\n', '\r\n');
      expect(file.bytes, file.path).to.equal(Buffer.byteLength(normalized, 'utf8'));
      expect(file.sha256, file.path).to.equal(sha256Bytes(Buffer.from(normalized, 'utf8')));
      expect(
        sha256Bytes(Buffer.from(simulatedCrLfCheckout.replaceAll(/\r\n?/g, '\n'), 'utf8')),
        file.path,
      ).to.equal(file.sha256);
    }

    expect(manifest.protocolDigestSemantics).to.equal(
      'SHA-256 over strict canonical JSON of every manifest member except protocolDigest.',
    );
    const {protocolDigest, ...digestProjection} = manifest;
    expect(protocolDigest).to.equal(digestCanonicalJson(digestProjection as JsonValue));
  });
});
