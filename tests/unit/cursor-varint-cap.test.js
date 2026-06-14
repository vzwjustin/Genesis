import { describe, it, expect } from "vitest";
import { decodeVarint } from "../../open-sse/utils/cursorProtobuf.js";

describe("decodeVarint 10-byte cap", () => {
  it("decodes a normal multi-byte varint", () => {
    // 300 = 0xAC 0x02 (LEB128)
    const [value, pos] = decodeVarint(Buffer.from([0xac, 0x02]), 0);
    expect(value).toBe(300);
    expect(pos).toBe(2);
  });

  it("stops after 10 bytes on a malformed all-continuation run", () => {
    // 16 bytes all with the continuation bit set, no terminator.
    const buf = Buffer.from(new Array(16).fill(0x80));
    const [, pos] = decodeVarint(buf, 0);
    // Without the cap this scanned to buffer.length (16); now it stops at 10.
    expect(pos - 0).toBe(10);
    expect(pos).toBeLessThan(buf.length);
  });

  it("respects the offset when applying the cap", () => {
    const buf = Buffer.from([0x00, 0x00, ...new Array(16).fill(0x80)]);
    const [, pos] = decodeVarint(buf, 2);
    expect(pos - 2).toBe(10);
  });
});
