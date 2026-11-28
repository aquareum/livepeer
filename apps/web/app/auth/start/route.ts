import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { seal } from "@/lib/auth/seal";
import { FLOW_COOKIE, authProvider, sessionSecret } from "@/lib/auth/session";
import { testSignInRefused } from "@/lib/auth/test-sign-in";
import type { SignInMethod } from "@/lib/auth/types";
import { signInMethods } from "@/lib/auth/methods";
import { nativeStart, type NativeFlow } from "@/lib/devices/flow";
import { invitationIn } from "@/lib/operators/links";
import { publicOrigin } from "@/lib/public-api/instance";

function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

const METHODS: SignInMethod[] = ["email", "passkey", "google", "apple", "discord", "coinbase", "wallet", "operator"];

/**
 * Begins sign-in with the chosen method: remembers where to return, then hands the browser to the identity
 * provider. The native apps open this in the system's auth session with `client`, `challenge` and `state`,
 * and get the result back at their own address instead of a cookie.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const origin = await publicOrigin(request);
  const native = await nativeStart(params);
  if (native && "refusal" in native) return native.refusal;

  const method = METHODS.find((entry) => entry === params.get("method"));
  const offered: string[] = await signInMethods();
  const forConsole = native?.flow.purpose === "operator";
  // The development operator sign-in is for the console: on the web, or in the app when it asks for the console.
  const allowed = method === "operator" ? (await authProvider()).id === "mock" && (!native || forConsole) : method !== undefined && offered.includes(method);
  if (!method || !allowed) {
    if (native) return native.fail("method");
    // No method, or one this instance doesn't offer: go to the sign-in screen to choose.
    const url = new URL("/sign-in", origin);
    const next = params.get("next");
    if (next) url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }
  // The test sign-in answers only where the public can't reach (`testSignInRefused`).
  if (await testSignInRefused(request)) {
    if (native) return native.fail("method");
    return NextResponse.redirect(new URL("/sign-in?error=test_only", origin));
  }
  const email = params.get("email")?.trim();
  const state = randomBytes(16).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const redirectUri = new URL("/auth/callback", origin).toString();
  const target = await (await authProvider()).authorizationUrl({ redirectUri, state, codeVerifier, method, ...(email ? { email } : {}), ...(forConsole || params.get("fresh") === "1" ? { fresh: true } : {}) });
  const response = NextResponse.redirect(new URL(target, origin));
  const next = safeNext(params.get("next"));
  const invitation = invitationIn(next);
  const flow: { state: string; codeVerifier: string; next: string; invitation?: string; native?: NativeFlow } = {
    state,
    codeVerifier,
    next,
    // A sign-in that began on an invitation's page carries it, so a closed instance lets its person in.
    ...(invitation ? { invitation } : {}),
    ...(native ? { native: native.flow } : {}),
  };
  response.cookies.set(FLOW_COOKIE, seal(flow, sessionSecret()), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  return response;
}
