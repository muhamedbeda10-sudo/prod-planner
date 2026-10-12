import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { chatStatusFor, playbookData } from "@/lib/server/ai/panel";
import { PageHead } from "@/components/ui";
import { PlaybookView } from "@/components/PlaybookView";

export const metadata = { title: "The assistant's playbook — ATC" };
export const dynamic = "force-dynamic";

// The plant's playbook: what the assistant is told about how this plant works
// — with every question and every automation's run. Anyone the assistant is
// opened to can read it (it is what shapes the answers they get); admins
// keep it, here or by telling the assistant.

export default async function PlaybookPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!(await chatStatusFor(me)).visible) redirect("/");
  const { rules, canEdit, left } = await playbookData(me);

  return (
    <div className="max-w-4xl">
      <PageHead title="Playbook" />
      <PlaybookView rules={rules} canEdit={canEdit} left={left} />
    </div>
  );
}
