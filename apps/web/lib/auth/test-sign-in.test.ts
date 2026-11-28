import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as start } from "../../app/auth/start/route";
import { useTestDatabase } from "../data/testing";
import { clientAddress, isLocalAddress, testSignInRefused } from "./test-sign-in";

const dir = mkdtempSync(path.join(tmpdir(), "livepeer-test-sign-in-"));
const configFile = path.join(dir, "instance.config.json");
let writes = 0;

function configure(extra: Record<string, unknown> = {}) {
  writeFileSync(configFile, JSON.stringify({ name: "Test", surfaces: { app: true, console: true, api: false, mcp: false }, auth: { provider: "mock" }, ...extra }));
  const next = new Date(statSync(configFile).mtimeMs + 2000 * (writes += 1));
  utimesSync(configFile, next, next);
}

const from = (address?: string) => ({ headers: new Headers(address ? { "x-forwarded-for": address } : {}) });
const PUBLIC = "203.0.113.7";

useTestDatabase();

beforeAll(() => {
  vi.stubEnv("INSTANCE_CONFIG", configFile);
  vi.stubEnv("MOCK_ONLY", "1");
  vi.stubEnv("SESSION_SECRET", "a-session-secret-for-the-test-sign-in-tests");
});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ALLOW_TEST_SIGN_IN", "");
  configure();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("where a request came from", () => {
  it("is the last address in X-Forwarded-For, the one the nearest proxy wrote", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": PUBLIC }))).toBe(PUBLIC);
    // Whatever the sender claimed comes first, and is not believed.
    expect(clientAddress(new Headers({ "x-forwarded-for": `127.0.0.1, ${PUBLIC}` }))).toBe(PUBLIC);
    expect(clientAddress(new Headers({ "x-forwarded-for": "::ffff:172.18.0.1" }))).toBe("172.18.0.1");
    expect(clientAddress(new Headers())).toBeNull();
    expect(clientAddress(new Headers({ "x-forwarded-for": "localhost" }))).toBeNull();
  });

  it("is local on this machine and on private networks, and nowhere else", () => {
    for (const address of ["127.0.0.1", "10.0.2.2", "172.18.0.1", "192.168.1.20", "169.254.1.1", "::1", "fd12:3456::1", "fe80::1"]) expect([address, isLocalAddress(address)]).toEqual([address, true]);
    for (const address of [PUBLIC, "8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1"]) expect([address, isLocalAddress(address)]).toEqual([address, false]);
  });
});

describe("the test sign-in in a production build", () => {
  it("answers the machine the instance runs on and private networks", async () => {
    expect(await testSignInRefused(from("127.0.0.1"))).toBe(false);
    expect(await testSignInRefused(from("172.18.0.1"))).toBe(false);
  });

  it("is refused to a request from a public address, or from nowhere it can tell", async () => {
    expect(await testSignInRefused(from(PUBLIC))).toBe(true);
    expect(await testSignInRefused(from(`127.0.0.1, ${PUBLIC}`))).toBe(true);
    expect(await testSignInRefused(from())).toBe(true);
  });

  it("is refused everywhere on an instance that names a public domain", async () => {
    configure({ domain: "video.example.com" });
    expect(await testSignInRefused(from("127.0.0.1"))).toBe(true);
    configure({ domain: "video.localhost" });
    expect(await testSignInRefused(from("127.0.0.1"))).toBe(false);
  });

  it("answers anyone when the operator says the demo is meant to be open", async () => {
    configure({ domain: "demo.example.com" });
    vi.stubEnv("ALLOW_TEST_SIGN_IN", "1");
    expect(await testSignInRefused(from(PUBLIC))).toBe(false);
  });

  it("is never refused outside a production build, or when sign-in is a real provider's", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await testSignInRefused(from(PUBLIC))).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    configure({ auth: { provider: "oidc", oidc: { issuer: "https://id.example.test", clientId: "web_test" } } });
    expect(await testSignInRefused(from(PUBLIC))).toBe(false);
  });

  it("sends a stranger back to the sign-in page with the reason, and starts no sign-in, the operator's included", async () => {
    for (const method of ["google", "operator"]) {
      const response = await start(new NextRequest(`http://localhost/auth/start?method=${method}`, { headers: { "x-forwarded-for": PUBLIC, "x-forwarded-host": "video.example.com", "x-forwarded-proto": "https" } }));
      expect(response.headers.get("location")).toBe("https://video.example.com/sign-in?error=test_only");
      expect(response.cookies.get("aq_auth_flow")).toBeUndefined();
    }
    const local = await start(new NextRequest("http://localhost/auth/start?method=operator", { headers: { "x-forwarded-for": "127.0.0.1" } }));
    expect(new URL(local.headers.get("location")!).pathname).toBe("/auth/callback");
    expect(local.cookies.get("aq_auth_flow")).toBeDefined();
  });
});
