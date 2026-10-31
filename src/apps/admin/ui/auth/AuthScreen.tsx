import { useEffect, useRef, useState } from "preact/hooks";
import { errorMessage } from "../api";
import { CopyButton } from "../components/CopyButton";
import { enroll, type Phase, type Setup, setNotice, signIn, signOut, verify } from "./session";

const COPY: Record<Exclude<Phase, "loading" | "ready">, { title: string; body: string }> = {
  signed_out: {
    title: "Sign in to your account",
    body: "Restricted to authorized operators. Two-factor authentication is required.",
  },
  enroll: {
    title: "Secure your operator account",
    body: "An authenticator is required before viewing operational data.",
  },
  verify: {
    title: "Verify your identity",
    body: "Enter the code from your authenticator to continue.",
  },
};

/** Runs a form action with a busy flag and a single error surface. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function AuthScreen({
  phase,
  notice,
  setup,
  email,
}: {
  phase: Exclude<Phase, "loading" | "ready">;
  notice: string | null;
  setup: Setup | null;
  email: string | null;
}) {
  const copy = COPY[phase];
  return (
    <main class="auth" id="main">
      <section class="auth-card" aria-labelledby="auth-title">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">
            Z
          </span>
          <span>Zephium Admin</span>
        </div>
        <h1 id="auth-title" class="auth-title">
          {copy.title}
        </h1>
        <p class="muted">{copy.body}</p>
        {email && phase !== "signed_out" ? (
          <p class="auth-account">
            Signed in as <strong>{email}</strong>
          </p>
        ) : null}
        <div class="auth-notice" role="alert">
          {notice}
        </div>
        {phase === "signed_out" ? <SignInForm /> : null}
        {phase === "enroll" ? <EnrollForm /> : null}
        {phase === "verify" ? <VerifyForm setup={setup} /> : null}
      </section>
    </main>
  );
}

function SignInForm() {
  const { busy, run } = useSubmit();
  return (
    <form
      class="form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const email = String(data.get("email") ?? "");
        const password = String(data.get("password") ?? "");
        void run(async () => {
          try {
            await signIn(email, password);
          } finally {
            form.reset();
          }
        });
      }}
    >
      <label class="field">
        <span>Email address</span>
        <input
          name="email"
          type="email"
          autocomplete="username"
          required
          maxLength={254}
          readOnly={busy}
        />
      </label>
      <label class="field">
        <span>Password</span>
        <input
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxLength={128}
          readOnly={busy}
        />
      </label>
      <button type="submit" class="btn btn-primary" disabled={busy}>
        {busy ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}

function EnrollForm() {
  const { busy, run } = useSubmit();
  return (
    <form
      class="form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const password = String(new FormData(form).get("password") ?? "");
        void run(async () => {
          try {
            await enroll(password);
          } finally {
            form.reset();
          }
        });
      }}
    >
      <p>Set up an authenticator app to access operational data.</p>
      <label class="field">
        <span>Confirm your password</span>
        <input
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxLength={128}
          readOnly={busy}
        />
      </label>
      <button type="submit" class="btn btn-primary" disabled={busy}>
        {busy ? "Setting up…" : "Set up authenticator"}
      </button>
      <button type="button" class="btn btn-quiet" onClick={() => void signOut()}>
        Start over
      </button>
    </form>
  );
}

function SetupDetails({ setup }: { setup: Setup }) {
  const codes = setup.backupCodes.join("\n");
  return (
    <section class="setup" aria-labelledby="setup-title">
      <h2 id="setup-title" class="setup-title">
        Add your authenticator
      </h2>
      <p class="muted">
        Enter this setup key in your authenticator app, or copy the setup URI. Then enter the app's
        six-digit code below.
      </p>
      <div class="field">
        <label for="setup-secret">Setup key</label>
        <div class="field-copy">
          <textarea id="setup-secret" readOnly rows={2} spellcheck={false} value={setup.secret} />
          <CopyButton value={setup.secret} label="Copy setup key" />
        </div>
      </div>
      <div class="field">
        <label for="setup-uri">Setup URI</label>
        <div class="field-copy">
          <textarea id="setup-uri" readOnly rows={3} spellcheck={false} value={setup.uri} />
          <CopyButton value={setup.uri} label="Copy setup URI" />
        </div>
      </div>
      <h3 class="setup-sub">Save your recovery codes</h3>
      <p class="muted">
        Keep these codes somewhere safe. Each code can be used once if you lose your authenticator.
      </p>
      <div class="field-copy">
        <textarea aria-label="Recovery codes" readOnly rows={5} spellcheck={false} value={codes} />
        <CopyButton value={codes} label="Copy recovery codes" />
      </div>
    </section>
  );
}

function VerifyForm({ setup }: { setup: Setup | null }) {
  const { busy, run } = useSubmit();
  const [backup, setBackup] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [backup]);
  return (
    <>
      {setup ? <SetupDetails setup={setup} /> : null}
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const code = String(new FormData(form).get("code") ?? "");
          void run(async () => {
            try {
              await verify(code, backup);
            } finally {
              form.reset();
            }
          });
        }}
      >
        <label class="field">
          <span>{backup ? "Recovery code" : "Authenticator code"}</span>
          <input
            ref={input}
            name="code"
            type="text"
            autocomplete="one-time-code"
            inputMode={backup ? "text" : "numeric"}
            required
            maxLength={64}
            spellcheck={false}
            readOnly={busy}
          />
        </label>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? "Verifying…" : "Verify and continue"}
        </button>
        {setup ? null : (
          <button type="button" class="btn btn-quiet" onClick={() => setBackup(!backup)}>
            {backup ? "Use an authenticator code" : "Use a recovery code"}
          </button>
        )}
        <button type="button" class="btn btn-quiet" onClick={() => void signOut()}>
          Start over
        </button>
      </form>
    </>
  );
}
