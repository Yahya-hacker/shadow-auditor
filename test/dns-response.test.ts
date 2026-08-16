import { expect } from 'chai';

import { buildDnsAResponse } from '../src/core/dast/dns-response.js';

// Build a minimal DNS query: 12-byte header + one question.
function buildQuery(opts: {
  id?: number;
  qdcount?: number;
  hostname?: string;
  qtype?: number;
} = {}): Buffer {
  const {
    id = 0x1234,
    qdcount = 1,
    hostname = 'oast-abc123.shadow.local',
    qtype = 1,
  } = opts;

  const labels = hostname.split('.').map((l) => Buffer.from([l.length]))
    .map((lenBuf, i) => Buffer.concat([lenBuf, Buffer.from(hostname.split('.')[i])]));

  const name = Buffer.concat([...labels, Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0); // ID
  header.writeUInt16BE(0x0100, 2); // RD=1
  header.writeUInt16BE(qdcount, 4); // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2); // QCLASS IN
  return Buffer.concat([header, name, tail]);
}

describe('buildDnsAResponse', () => {
  it('returns null for non-Buffers and tiny packets', () => {
    expect(buildDnsAResponse('nope' as unknown as Buffer, '1.2.3.4')).to.equal(null);
    expect(buildDnsAResponse(Buffer.alloc(11), '1.2.3.4')).to.equal(null);
  });

  it('returns null when the query carries no questions', () => {
    const q = buildQuery({ qdcount: 0 });
    expect(buildDnsAResponse(q, '1.2.3.4')).to.equal(null);
  });

  it('returns null for a malformed IP', () => {
    const q = buildQuery();
    expect(buildDnsAResponse(q, '999.1.1.1')).to.equal(null);
    expect(buildDnsAResponse(q, '1.2.3')).to.equal(null);
    expect(buildDnsAResponse(q, 'not-an-ip')).to.equal(null);
  });

  it('echoes the ID and sets standard response flags', () => {
    const q = buildQuery({ id: 0xbeef });
    const resp = buildDnsAResponse(q, '1.2.3.4')!;
    expect(resp).to.not.equal(null);
    expect(resp.readUInt16BE(0)).to.equal(0xbeef); // ID echoed
    expect(resp.readUInt16BE(2)).to.equal(0x8180); // QR + RA + RD
  });

  it('answers a single question with one A record pointing at the IP', () => {
    const q = buildQuery({ hostname: 'oast-aabbccdd.shadow.local' });
    const resp = buildDnsAResponse(q, '172.18.0.2')!;

    // ANCOUNT = 1
    expect(resp.readUInt16BE(6)).to.equal(1);

    const ipBytes = Buffer.from([172, 18, 0, 2]);
    expect(resp.slice(-4).equals(ipBytes)).to.equal(true);

    // TTL 60, RDLENGTH 4
    expect(resp.readUInt32BE(resp.length - 10)).to.equal(60);
    expect(resp.readUInt16BE(resp.length - 6)).to.equal(4);
  });

  it('parses multi-octet IPs and answers multiple questions', () => {
    const q = buildQuery({ qdcount: 0 });
    // Rebuild with qdcount 2 by crafting manually
    const q1 = buildQuery({ hostname: 'a.shadow.local', id: 0x1111, qdcount: 2 });
    // q1 currently only has ONE question despite qdcount=2; append a second question
    const secondQuestion = Buffer.from([
      1, 'b'.charCodeAt(0), 0, // name: "b. root"
      0, 1, 0, 1,
    ]);
    const multi = Buffer.concat([q1, secondQuestion]);
    const resp = buildDnsAResponse(multi, '10.0.0.9')!;
    expect(resp.readUInt16BE(6)).to.equal(2); // ANCOUNT = 2
  });

  it('handles a compression-pointer question without overrunning the buffer', () => {
    // Header + pointer-only name (offset not relevant for parsing) + qtype/qclass
    const q = Buffer.alloc(12 + 2 + 4);
    q.writeUInt16BE(0x2222, 0);
    q.writeUInt16BE(0x0100, 2);
    q.writeUInt16BE(1, 4); // QDCOUNT=1
    q[12] = 0xc0; q[13] = 0x0c; // compression pointer to offset 12
    q.writeUInt16BE(1, 14); // QTYPE A
    q.writeUInt16BE(1, 16); // QCLASS IN

    const resp = buildDnsAResponse(q, '5.6.7.8')!;
    expect(resp).to.not.equal(null);
    expect(resp.readUInt16BE(6)).to.equal(1);
    expect(resp.slice(-4).equals(Buffer.from([5, 6, 7, 8]))).to.equal(true);
  });
});