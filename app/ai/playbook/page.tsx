import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { aiStatusFor } from "@/lib/server/ai/access";
import { playbookText } from "@/lib/domain/aiPlaybook";
import { PageHead } from "@/components/ui";
import { PlaybookView, type PlaybookRuleView } from "@/components/PlaybookView";

export const metadata = { title: "The assistant's playbook — ATC" };
export const dynamic = "force-dynamic";

// The plant's playbook: what the assistant is told about how this plant works
// — with every question and every automation's run. Anyone the assistant is
// opened to can read it (it is what shapes the answers they get); admins
// keep it, here or by telling the assistant.

export default async function PlaybookPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const status = await aiStatusFor(me);
  if (!status.visible) redirect("/");

  const rows = await prisma.aiPlaybookEntry.findMany({
    orderBy: [{ active: "desc" }, { topic: "asc" }, { id: "asc" }],
    include: { revisions: { orderBy: { id: "desc" }, take: 5 } },
  });
  const { left } = playbookText(rows.filter((r) => r.active));
  const rules: PlaybookRuleView[] = rows.map((r) => ({
    id: r.id, topic: r.topic, title: r.title, body: r.body, active: r.active,
    updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString(),
    revisions: r.revisions.map((v) => ({ id: v.id, action: v.action, by: v.by, at: v.at.toISOString() })),
  }));

  return (
    <div>
      <PageHead title="The assistant's playbook" sub="How this plant works — the assistant is told these with every question and every automation" />
      <PlaybookView rules={rules} canEdit={me.isAdmin} left={left} />
    </div>
  );
}
