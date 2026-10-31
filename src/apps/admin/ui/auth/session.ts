import { useEffect, useState } from "preact/hooks";
import { ApiError, api, errorMessage, isAbort, type Operator, onApiEvent, post } from "../api";

/**
 * Operator session state machine: loading -> signed_out | enroll | verify -> ready.
 * Credentials never enter this state; passwords and codes live in uncontrolled form fields that
 * are cleared immediately after submission. The one-time authenticator setup (secret and
 * recovery codes) is held only until sign-in completes or the page is left.
 */
export type Phase = "loading" | "signed_out" | "enroll" | "verify" | "ready";
export type Setup = { uri: string; secret: string; backupCodes: string[] };
export type SessionState = {
  phase: Phase;
  operator: Operator | null;
  notice: string | null;
  accessExpired: boolean;
  setup: Setup | null;
};

const EXPIRED = "Your session has expired. Sign in again to continue.";
let state: SessionState = {
  phase: "loading",
  operator: null,
  notice: null,
  accessExpired: false,
  setup: null,
};
const listeners = new Set<(next: SessionState) => void>();
let generation = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function update(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function useSession(): SessionState {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    listeners.add(setSnapshot);
    setSnapshot(state);
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}

export function setNotice(message: string | null): void {
  update({ notice: message });
}

function scheduleExpiry(expiresAt: string): void {
  clearTimeout(expiryTimer);
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining)) return;
  if (remaining <= 0) {
    resetAuth(EXPIRED);
    return;
  }
  expiryTimer = setTimeout(() => scheduleExpiry(expiresAt), Math.min(remaining, 2_147_483_647));
}

/** Drop every in-memory trace of the operator and return to the sign-in form. */
export function resetAuth(message: string | null = null): void {
  generation++;
  clearTimeout(expiryTimer);
  update({ phase: "signed_out", operator: null, setup: null, notice: message });
}

export async function loadSession(fallback: "signed_out" | "verify" = "signed_out"): Promise<void> {
  const current = generation;
  try {
    const { operator } = await api.session();
    if (current !== generation) return;
    scheduleExpiry(operator.expiresAt);
    if (current !== generation) return; // The expiry check may have reset.
    const phase: Phase = !operator.enrolled ? "enroll" : !operator.mfaVerified ? "verify" : "ready";
    update({
      operator,
      phase,
      ...(phase === "ready" ? { setup: null, notice: null } : {}),
    });
  } catch (error) {
    if (current !== generation || isAbort(error)) return;
    if (error instanceof ApiError && error.kind === "unauthorized") {
      update({ phase: fallback, operator: null });
      return;
    }
    update({ phase: "signed_out", operator: null, notice: errorMessage(error) });
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const current = generation;
  const result = await post<{ twoFactorRedirect?: boolean }>("/auth/sign-in/email", {
    email: email.trim(),
    password,
  });
  if (current === generation) await loadSession(result.twoFactorRedirect ? "verify" : "signed_out");
}

export async function enroll(password: string): Promise<void> {
  const current = generation;
  const result = await post<{ totpURI: string; backupCodes: string[] }>("/auth/two-factor/enable", {
    password,
  });
  if (current !== generation) return;
  const uri = new URL(result.totpURI);
  if (uri.protocol !== "otpauth:") throw new Error("Invalid authenticator setup");
  const setup: Setup = {
    uri: result.totpURI,
    secret: uri.searchParams.get("secret") ?? "",
    backupCodes: result.backupCodes,
  };
  await loadSession("verify");
  if (current !== generation) return;
  update({ setup, phase: "verify" });
}

export async function verify(code: string, backup: boolean): Promise<void> {
  const current = generation;
  await post(backup ? "/auth/two-factor/verify-backup-code" : "/auth/two-factor/verify-totp", {
    code: code.trim(),
  });
  if (current === generation) await loadSession("signed_out");
}

export async function signOut(): Promise<void> {
  try {
    await post("/auth/sign-out", {});
    resetAuth();
  } catch (error) {
    resetAuth(`Sign-out could not be confirmed. ${errorMessage(error)}`);
  }
}

// Reactions to what data requests discover about the session.
onApiEvent((event) => {
  if (event === "access_expired") update({ accessExpired: true });
  else if (event === "ok") {
    if (state.accessExpired) update({ accessExpired: false });
  } else if (state.phase === "ready") {
    if (event === "unauthorized") resetAuth(EXPIRED);
    else {
      update({ notice: "Verification expired. Enter a new authenticator code to continue." });
      void loadSession("verify");
    }
  }
});

// Never leave operator data in a page restored from the back/forward cache.
window.addEventListener("pagehide", () => resetAuth());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void loadSession();
});
