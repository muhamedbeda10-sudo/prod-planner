"use client";

import { Factory } from "lucide-react";
import { setMachinePlanning } from "./actions";
import { PlantSwitch } from "./PlantSwitch";

// One switch for the worklists, the machines and planning work onto them —
// they all serve one job, so they are turned on together and off together.
// Off, their tabs and pages are gone and the Floor tab opens the what-if
// simulator; nothing is deleted.

export function MachinePlanningToggle({ initialOn }: { initialOn: boolean }) {
  return (
    <PlantSwitch
      icon={Factory}
      title="Worklists & machine planning"
      description="The department worklists, the machines with their times per piece, and which machine each line is on — one switch for all of it. The Shifts tab stays either way."
      rowTitle="Plan the work onto machines"
      rowHint="Off: no worklists and no machine pages; the Floor tab is the what-if simulator alone."
      initialOn={initialOn}
      action={setMachinePlanning}
      onText="Worklists and machine planning are on."
      offText="Worklists and machine planning are off."
      whileOn={[
        "The Worklist tab is in the bar",
        "Admin Tools lists Machines & Lines and Times per Machine",
        "The Fabrication, Welding and Painting worklists show the machine board",
        "Every line carries a Machine picker and the on-machine / to-place filter",
        "The Floor tab opens the bay drawings with what each machine is on",
        "The printable machine sheets are available",
      ]}
      whileOff={[
        "The Worklist tab is gone, and so are Machines & Lines and Times per Machine",
        "The dashboard drops machine downtime",
        "The Floor tab opens the what-if simulator",
        "Assignments already made stay saved and come back when you turn it on",
      ]}
    />
  );
}
