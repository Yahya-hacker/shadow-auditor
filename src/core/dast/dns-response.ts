/**
 * Minimal DNS A-record response builder for the Mirage OAST sidecar.
 *
 * The Mirage runs a UDP DNS server on port 53 inside the internal sandbox
 * network. It answers ANY query (wildcard) with an A record pointing at the
 * Mirage container itself, so SSRF / blind-RCE payloads that connect directly
 * to `oast-{token}.shadow.local` (or any other hostname) resolve to the Mirage
 * and reach the HTTP callback logger on :8080. Without this, such payloads fail
 * DNS resolution on an `--internal` docker network (Docker's embedded DNS only
 * resolves container names) and silently produce false negatives.
 *
 * The function is kept self-contained (no imports) so its source can be inlined
 * into the container's `node -e` script via `Function.prototype.toString()`,
 * guaranteeing the container runs exactly the code under test.
 */

/**
 * Build a complete DNS response buffer for a query packet.
 *
 * @param query - Raw DNS query bytes received from the wire.
 * @param ip    - IPv4 address (string) to return in the A records.
 * @returns A standard DNS response, or `null` if the packet is malformed or
 *          carries no questions (so the caller can silently drop it).
 */
export function buildDnsAResponse(query: Buffer, ip: string): Buffer | null {
  if (!Buffer.isBuffer(query) || query.length < 12) return null;

  const qdcount = query.readUInt16BE(4);
  if (qdcount === 0) return null;

  const parts = String(ip).split('.').map((n) => Number(n) || 0);
  if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return null;

  // Walk the question section(s): each is NAME (labels) + QTYPE(2) + QCLASS(2).
  let offset = 12;
  for (let q = 0; q < qdcount; q++) {
    for (;;) {
      if (offset >= query.length) return null;
      const len = query[offset];
      if (len === 0) {
        offset += 1;
        break;
      }
      // Compression pointer (unneeded for our own questions, but avoid reading
      // past the buffer if one appears in a forwarded request).
      if ((len & 0xc0) === 0xc0) {
        offset += 2;
        break;
      }
      offset += 1 + len;
      if (offset > query.length) return null;
    }
    offset += 4;
    if (offset > query.length) return null;
  }

  const questionEnd = offset;

  // Response = copied header+question, then qdcount A answers.
  const response = Buffer.alloc(questionEnd + qdcount * 16);
  query.copy(response, 0, 0, questionEnd);

  // Flags: QR=1, RD=echoed(we set it), RA=1, opcode=0 => 0x8180.
  response.writeUInt16BE(0x8180, 2);
  // ANCOUNT = the number of questions we answer.
  response.writeUInt16BE(qdcount, 6);

  let cursor = questionEnd;
  for (let q = 0; q < qdcount; q++) {
    response.writeUInt16BE(0xc00c, cursor); // pointer back to question NAME
    response.writeUInt16BE(1, cursor + 2);  // QTYPE A
    response.writeUInt16BE(1, cursor + 4);  // QCLASS IN
    response.writeUInt32BE(60, cursor + 6); // TTL 60s
    response.writeUInt16BE(4, cursor + 10); // RDLENGTH = 4
    response[cursor + 12] = parts[0];
    response[cursor + 13] = parts[1];
    response[cursor + 14] = parts[2];
    response[cursor + 15] = parts[3];
    cursor += 16;
  }

  return response;
}