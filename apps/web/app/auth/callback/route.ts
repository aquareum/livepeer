import { NextResponse, type NextRequest } from "next/server";

import { isFresh } from "@/lib/auth/fresh";
import { seal, unseal } from "@/lib/auth/seal";
import { admitted } from "@/lib/auth/sign-up";
import { testSignInRefused } from "@/lib/auth/test-sign-in";
import { FLOW_COOKIE, SESSION_COOKIE, authProvider, createSession, sessionSecret } from "@/lib/auth/session";
import { appCallback, devices, mobileEnabled } from "@/lib/devices";
import { returnToApp, type NativeFailure, type NativeFlow } from "@/lib/devices/flow";
import { mobileConsoleEnabled, operatorDevices } from "@/lib/operator-devices";
import { operators } from "@/lib/operators";
import { publicOrigin } from "@/lib/public-api/instance";

interface Flow {
  state: string;
  codeVerifier: string;
  next: string;
  /** An invitation to the team the sign-in began from, which lets a new person into a closed instance. */
  invitation?: string;
  native?: NativeFlow;
}

/**
 * Completes sign-in: checks the state and exchanges the code. A browser gets the sealed session cookie. A
 * native app gets a one-time code at its own address, which it exchanges with its verifier for a device
 * session (POST /api/v1/auth/device), so no session ever passes through the browser. A sign-in for the
 * console on a phone ends the same way, with a code for an operator device session
 * (POST /api/v1/auth/operator-device), and only for an operator who signed in at the provider just now.
 *
 * Whether the person is an operator is decided here, from the provider's word and the instance's own team
 * list, and an instance that is closed to new accounts turns away anyone it has never seen (`closed`).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const origin = await publicOrigin(request);
  const code = params.get("code");
  const flow = unseal<Flow>(request.cookies.get(FLOW_COOKIE)?.value ?? "", sessionSecret());
  const callback = flow?.native ? await appCallback(flow.native.platform) : null;
  const finish = (response: NextResponse) => {
    response.cookies.delete(FLOW_COOKIE);
    return response;
  };

  if (flow?.native && !callback) return finish(new NextResponse("This instance no longer has an app for that platform.", { status: 400 }));
  const fail = (reason: Exclude<NativeFailure, "method">) =>
    finish(flow?.native && callback ? returnToApp(callback, { error: reason, state: flow.native.state }) : NextResponse.redirect(new URL(`/sign-in?error=${reason === "expired" || reason === "closed" ? reason : "failed"}`, origin)));

  if (!code || !flow || flow.state !== params.get("state")) return fail("expired");
  // Checked again where the session is made: the test sign-in answers only where the public can't reach.
  if (await testSignInRefused(request)) return fail("failed");
  const redirectUri = new URL("/auth/callback", origin).toString();
  let identity;
  let authenticatedAt;
  try {
    ({ identity, authenticatedAt } = await (await authProvider()).exchange({ code, redirectUri, codeVerifier: flow.codeVerifier }));
  } catch (error) {
    // Said in the server's log, where the operator can find out why nobody can sign in: which step the
    // provider refused, and its error code. Neither the code nor any token is in it.
    console.error(`[auth] sign-in failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return fail("failed");
  }

  // Whether they are an operator is the identity provider's word or this instance's own team list.
  const standing = await operators().signIn(identity, identity.role === "operator");
  identity = { ...identity, role: standing.role };

  // An instance that isn't taking new accounts makes no session for someone it has never seen.
  let allowed;
  try {
    allowed = await admitted(identity, standing, flow.invitation ?? null);
  } catch {
    return fail("failed");
  }
  if (!allowed) return fail("closed");
  // Someone who is no longer an operator keeps no console on a phone either.
  if (standing.role === "user") await operatorDevices().revokeUser(identity.userId, "operator role removed");

  if (flow.native?.purpose === "operator" && callback) {
    if (!await mobileConsoleEnabled()) return fail("mobile_console_off");
    // A session the provider already had for this browser doesn't enrol a phone: the sign-in must be new.
    if (!isFresh(authenticatedAt)) return fail("not_fresh");
    // Null for anyone the provider doesn't mark as an operator: no code, so no session.
    const handoff = await operatorDevices().issueCode({ identity, challenge: flow.native.challenge, platform: flow.native.platform });
    if (!handoff) return fail("not_operator");
    return finish(returnToApp(callback, { code: handoff, state: flow.native.state, purpose: "operator" }));
  }

  if (flow.native && callback) {
    if (!await mobileEnabled()) return fail("mobile_off");
    const { builderKey } = createSession(identity);
    const handoff = await devices().issueCode({
      // A device session never does operator work, whoever signs in. It records the role only so the app knows
      // whether to offer the console, which has its own session, key and biometric check.
      identity,
      builderKey: builderKey ? seal(builderKey, sessionSecret()) : null,
      challenge: flow.native.challenge,
      platform: flow.native.platform,
    });
    return finish(returnToApp(callback, { code: handoff, state: flow.native.state }));
  }

  const destination = identity.role === "operator" || !flow.next.startsWith("/operator") ? flow.next : "/";
  const response = NextResponse.redirect(new URL(destination, origin));
  response.cookies.set(SESSION_COOKIE, seal(createSession(identity, { ...(standing.source ? { operatorSource: standing.source } : {}), authenticatedAt }), sessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 3600,
  });
  return finish(response);
}
