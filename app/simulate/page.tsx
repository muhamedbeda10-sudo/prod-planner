import { redirect } from "next/navigation";

// The What-if Simulator screen is gone: the assistant runs the what-ifs
// (lib/server/ai/tools/simulator.ts). An old link or bookmark lands on it.
export default function SimulatePage() {
  redirect("/ai");
}
