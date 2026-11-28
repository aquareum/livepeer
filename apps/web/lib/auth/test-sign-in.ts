import "server-only";

import { isIP } from "node:net";

import { env } from "../env";
import { instance } from "../instance";
import { authProvider } from "./session";

/**
 * The address a request came from: the last one in `X-Forwarded-For`, which is the one the nearest proxy
 * wrote, or, with no proxy, the connection's own address, which Next.js writes there itself. Earlier
 * entries are whatever the sender claimed. Null when there is none.
 */
export function clientAddress(headers: Headers): string | null {
  const last = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  if (!last) return null;
  // An IPv4 address carried in IPv6 form, as a dual-stack socket reports it.
  const address = last.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return isIP(address) ? address : null;
}

/** Whether an address is this machine or a private network: nowhere the public internet can come from. */
export function isLocalAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = address.toLowerCase();
  return lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

const localName = (host: string) => host === "localhost" || host.endsWith(".localhost") || host.endsWith(".test");

/**
 * Whether the test sign-in must be refused to this request. The test sign-in (`auth.provider: "mock"`)
 * signs anyone in as a sample user, and as the sample operator if they ask, so it is for looking at an
 * instance and never for running one. In a production build it answers only where the public can't reach:
 *
 * - not on an instance that names a public domain, which is how an instance says it is published;
 * - not to a request that arrived from a public address.
 *
 * So `./livepeer setup` on a server still gives a working instance to look at from that server or through
 * an SSH tunnel, and pointing a domain at it doesn't hand the console to whoever finds it.
 * `ALLOW_TEST_SIGN_IN=1` lifts this for a demo that is meant to be open, or one something else protects.
 * A development server (`pnpm dev`) is never refused: phones on the desk reach it at the machine's address.
 */
export async function testSignInRefused(request: { headers: Headers }): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return false;
  if ((await authProvider()).id !== "mock") return false;
  if (env("ALLOW_TEST_SIGN_IN") === "1") return false;
  const domain = (await instance()).domain;
  if (domain && !localName(domain.toLowerCase())) return true;
  const address = clientAddress(request.headers);
  return !address || !isLocalAddress(address);
}
