import { describe, expect, test } from "bun:test";
import { csvField, csvRow } from "../csv";

describe("csvField", () => {
  test("quotes and doubles embedded quotes", () => {
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("a,b\nc")).toBe('"a,b\nc"');
  });
  test("neutralises spreadsheet formulas", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"])
      expect(csvField(bad)).toBe(`"'${bad}"`);
    expect(csvField("a=b")).toBe('"a=b"');
    expect(csvField("x@example.com")).toBe('"x@example.com"');
  });
  test("rows join fields", () => {
    expect(csvRow(["a@b.co", "2026-10-31T00:00:00.000Z"])).toBe(
      '"a@b.co","2026-10-31T00:00:00.000Z"',
    );
  });
});
