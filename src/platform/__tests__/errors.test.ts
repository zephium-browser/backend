import { expect, test } from "bun:test";
import { errorFields } from "../errors";

test("error diagnostics keep class, code and locations but never the message", () => {
  const error = Object.assign(new TypeError("invalid input for user@example.test: secret-token"), {
    code: "22P02",
  });
  const fields = errorFields(error);
  expect(fields).toMatchObject({ error_type: "TypeError", error_code: "22P02" });
  expect(Array.isArray(fields.frames) && fields.frames.length).toBeGreaterThan(0);
  const serialized = JSON.stringify(fields);
  expect(serialized).not.toContain("user@example.test");
  expect(serialized).not.toContain("secret-token");
  expect(errorFields(Object.assign(new Error("x"), { code: "has spaces; DROP" })).error_code).toBe(
    undefined,
  );
  expect(errorFields("raw string")).toEqual({ error_type: "string" });
});
