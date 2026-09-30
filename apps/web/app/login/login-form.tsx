"use client";
import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, {});
  if (state.sent) return <p role="status">Check your inbox for a sign-in link.</p>;
  return (
    <form action={action} className="stack">
      <label>
        Work email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      <button type="submit" className="primary" disabled={pending}>{pending ? "Sending…" : "Send sign-in link"}</button>
    </form>
  );
}
