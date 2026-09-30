import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <main style={{ maxWidth: 420 }}>
      <h1>That link didn't work</h1>
      <p className="muted">Sign-in links expire and can be used once. Request a new one.</p>
      <Link className="button primary" href="/login">Back to sign in</Link>
    </main>
  );
}
