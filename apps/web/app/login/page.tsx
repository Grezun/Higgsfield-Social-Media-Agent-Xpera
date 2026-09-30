import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main style={{ maxWidth: 420 }}>
      <h1>Sign in</h1>
      <p className="muted">We'll email you a one-time sign-in link.</p>
      <div className="card"><LoginForm /></div>
    </main>
  );
}
