import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "./actions";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = { title: "Reel Studio" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims?.email === "string" ? data.claims.email : null;
  return (
    <html lang="en">
      <body>
        <header className="app">
          <Link href="/">Reel Studio</Link>
          {email && (
            <form action={signOut} className="row">
              <span className="muted">{email}</span>
              <button type="submit">Sign out</button>
            </form>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
