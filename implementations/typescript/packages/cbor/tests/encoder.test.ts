import { describe, it, expect } from "vitest";
import { encodeCbor, decodeCbor, intMap, strMap, CborError } from "../src/index.js";

function hex(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    bytes[i / 2] = parseInt(s.slice(i, i + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

describe("CBOR encoder — exact byte matches (Rust aafp-cbor)", () => {
  it("encodes unsigned integers", () => {
    expect(toHex(encodeCbor({ type: "uint", value: 0 }))).toBe("00");
    expect(toHex(encodeCbor({ type: "uint", value: 1 }))).toBe("01");
    expect(toHex(encodeCbor({ type: "uint", value: 23 }))).toBe("17");
    expect(toHex(encodeCbor({ type: "uint", value: 24 }))).toBe("1818");
    expect(toHex(encodeCbor({ type: "uint", value: 100 }))).toBe("1864");
    expect(toHex(encodeCbor({ type: "uint", value: 1000 }))).toBe("1903e8");
  });

  it("encodes negative integers", () => {
    expect(toHex(encodeCbor({ type: "int", value: -1 }))).toBe("20");
    expect(toHex(encodeCbor({ type: "int", value: -10 }))).toBe("29");
    expect(toHex(encodeCbor({ type: "int", value: -100 }))).toBe("3863");
  });

  it("encodes byte strings", () => {
    expect(toHex(encodeCbor({ type: "bytes", value: hex("010203") }))).toBe("43010203");
  });

  it("encodes text strings", () => {
    expect(toHex(encodeCbor({ type: "text", value: "hi" }))).toBe("626869");
  });

  it("encodes bool and null", () => {
    expect(toHex(encodeCbor({ type: "bool", value: true }))).toBe("f5");
    expect(toHex(encodeCbor({ type: "bool", value: false }))).toBe("f4");
    expect(toHex(encodeCbor({ type: "null" }))).toBe("f6");
  });

  it("encodes arrays", () => {
    expect(
      toHex(
        encodeCbor({
          type: "array",
          items: [
            { type: "uint", value: 1 },
            { type: "uint", value: 2 },
          ],
        }),
      ),
    ).toBe("820102");
  });

  it("encodes int maps with canonical ordering", () => {
    // Keys 1, 2, 5, 10 — all 1-byte, sorted numerically
    expect(
      toHex(
        encodeCbor(
          intMap([
            [10, { type: "uint", value: 100 }],
            [2, { type: "uint", value: 20 }],
            [1, { type: "uint", value: 10 }],
            [5, { type: "uint", value: 50 }],
          ]),
        ),
      ),
    ).toBe("a4010a02140518320a1864");
  });

  it("encodes int maps with mixed key lengths", () => {
    // Key 1 (1-byte: 0x01) sorts before key 24 (2-byte: 0x18 0x18)
    expect(
      toHex(
        encodeCbor(
          intMap([
            [24, { type: "uint", value: 2 }],
            [1, { type: "uint", value: 1 }],
          ]),
        ),
      ),
    ).toBe("a20101181802");
  });

  it("encodes empty maps and arrays", () => {
    expect(toHex(encodeCbor(intMap([])))).toBe("a0");
    expect(toHex(encodeCbor({ type: "array", items: [] }))).toBe("80");
  });
});

describe("CBOR decoder — canonical rejection", () => {
  it("rejects indefinite-length arrays", () => {
    expect(() => decodeCbor(hex("9f01ff"))).toThrow(CborError);
  });

  it("rejects non-shortest integer encoding", () => {
    // 0x18 0x01 = value 1 encoded with 1-byte AI (should be immediate 0x01)
    expect(() => decodeCbor(hex("1801"))).toThrow(CborError);
  });

  it("rejects deep nesting (>100)", () => {
    const deep = new Uint8Array(201);
    deep.fill(0x81, 0, 200); // 200 × array(1)
    deep[200] = 0x00; // unsigned(0)
    expect(() => decodeCbor(deep)).toThrow(CborError);
  });

  it("rejects duplicate map keys", () => {
    // Map with two entries with key 1: {1: 2, 1: 3}
    expect(() => decodeCbor(hex("a201020103"))).toThrow(CborError);
  });
});

describe("CBOR roundtrip determinism", () => {
  it("canonical encoding is deterministic regardless of insertion order", () => {
    const map1 = intMap([
      [3, { type: "uint", value: 3 }],
      [1, { type: "uint", value: 1 }],
      [2, { type: "uint", value: 2 }],
    ]);
    const map2 = intMap([
      [1, { type: "uint", value: 1 }],
      [2, { type: "uint", value: 2 }],
      [3, { type: "uint", value: 3 }],
    ]);
    expect(toHex(encodeCbor(map1))).toBe(toHex(encodeCbor(map2)));
  });

  it("str map canonical ordering: cat < apple < zebra", () => {
    const decoded = decodeCbor(
      encodeCbor(
        strMap([
          ["zebra", { type: "uint", value: 1 }],
          ["apple", { type: "uint", value: 2 }],
          ["cat", { type: "uint", value: 3 }],
        ]),
      ),
    );
    expect(decoded.type).toBe("text-map");
    if (decoded.type === "text-map") {
      const keys = decoded.entries.map(([k]) => k);
      expect(keys).toEqual(["cat", "apple", "zebra"]);
    }
  });

  it("roundtrips all variants", () => {
    const values = [
      { type: "uint", value: 42 } as const,
      { type: "int", value: -17 } as const,
      { type: "bytes", value: hex("deadbeef") } as const,
      { type: "text", value: "hello world" } as const,
      { type: "bool", value: true } as const,
      { type: "null" } as const,
      { type: "array", items: [{ type: "uint", value: 1 }, { type: "text", value: "x" }] } as const,
      intMap([[1, { type: "uint", value: 2 }]]),
      strMap([["k", { type: "bool", value: false }]]),
    ];
    for (const v of values) {
      const encoded = encodeCbor(v);
      const decoded = decodeCbor(encoded);
      expect(decoded).toEqual(v);
    }
  });
});
