import { describe, expect, test } from "bun:test";
import { parseHash, toHash } from "../router";

describe("parseHash", () => {
  test("empty hash is the 7 day overview", () => {
    expect(parseHash("")).toEqual({ name: "overview", days: 7 });
    expect(parseHash("#/")).toEqual({ name: "overview", days: 7 });
  });
  test("period parameters", () => {
    expect(parseHash("#/overview?days=1")).toEqual({ name: "overview", days: 1 });
    expect(parseHash("#/overview?days=30")).toEqual({ name: "overview", days: 30 });
    expect(parseHash("#/overview?days=999")).toEqual({ name: "overview", days: 7 });
    expect(parseHash("#/activity")).toEqual({ name: "activity", days: 30 });
    expect(parseHash("#/activity?days=90")).toEqual({ name: "activity", days: 90 });
    expect(parseHash("#/activity?days=7")).toEqual({ name: "activity", days: 30 });
  });
  test("user search and filter live in the URL", () => {
    expect(parseHash("#/users?q=a%40b.co&filter=paying")).toEqual({
      name: "users",
      q: "a@b.co",
      filter: "paying",
    });
    expect(parseHash("#/users?filter=bogus")).toEqual({ name: "users", q: "", filter: "" });
    expect(parseHash("#/users?q=%20x%20").name).toBe("users");
    expect(parseHash(`#/users?q=${"a".repeat(400)}`)).toMatchObject({ q: "a".repeat(320) });
  });
  test("user detail ids are decoded and bounded", () => {
    expect(parseHash("#/users/abc%2Fdef")).toEqual({ name: "user", id: "abc/def" });
    expect(parseHash("#/users/%E0%A4%A")).toEqual({ name: "not_found" });
    expect(parseHash(`#/users/${"x".repeat(129)}`)).toEqual({ name: "not_found" });
  });
  test("simple views and unknown routes", () => {
    for (const name of ["revenue", "jobs", "waitlist", "audit"] as const)
      expect(parseHash(`#/${name}`)).toEqual({ name });
    expect(parseHash("#/jobs/extra")).toEqual({ name: "not_found" });
    expect(parseHash("#/nope")).toEqual({ name: "not_found" });
    expect(parseHash("#/users/a/b")).toEqual({ name: "not_found" });
  });
});

describe("toHash", () => {
  test("round trips every route", () => {
    const routes = [
      { name: "overview", days: 1 },
      { name: "overview", days: 7 },
      { name: "overview", days: 30 },
      { name: "revenue" },
      { name: "activity", days: 30 },
      { name: "activity", days: 90 },
      { name: "users", q: "a+b@example.com", filter: "unverified" },
      { name: "users", q: "", filter: "" },
      { name: "user", id: "id with/odd?chars#" },
      { name: "jobs" },
      { name: "waitlist" },
      { name: "audit" },
    ] as const;
    for (const route of routes) expect(parseHash(toHash(route))).toEqual(route);
  });
  test("defaults are omitted from the URL", () => {
    expect(toHash({ name: "overview", days: 7 })).toBe("#/overview");
    expect(toHash({ name: "users", q: "", filter: "" })).toBe("#/users");
  });
});
