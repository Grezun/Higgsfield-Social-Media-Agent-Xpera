import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NewReelForm } from "./new-reel-form";

export default async function NewReelPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");
  return (
    <main className="stack">
      <h1>New reel</h1>
      <NewReelForm />
    </main>
  );
}
