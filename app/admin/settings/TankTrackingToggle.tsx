"use client";

import { Droplets } from "lucide-react";
import { setTankTracking } from "./actions";
import { PlantSwitch } from "./PlantSwitch";

// The master switch for per-piece tank tracking. It changes how four screens
// behave and what the shop floor is asked to do, so what changes is written
// out under it.

export function TankTrackingToggle({ initialOn }: { initialOn: boolean }) {
  return (
    <PlantSwitch
      icon={Droplets}
      title="Tank tracking (per piece)"
      description="Every tank as its own piece: a serial at welding, a leak test before painting, painting by picking the tanks, and a barcode sticker."
      rowTitle="Track every tank by its serial"
      rowHint="Off: a tank is a quantity like every other component."
      initialOn={initialOn}
      action={setTankTracking}
      confirmOff={
        "Turn per-piece tank tracking OFF?\n\n" +
        "Tanks go back to being recorded as quantities everywhere, with no serial and no leak test. " +
        "The Leak Test and Barcode tabs disappear.\n\n" +
        "Nothing is deleted — the tanks already recorded stay in the database and pick up where they left off when you turn it back on."
      }
      onText="Tank tracking is on."
      offText="Tank tracking is off."
      whileOn={[
        "Welding a tank mints a serial and asks who welded it",
        "Every tank must pass the leak test before it can be painted",
        "Painting is recorded by picking tanks, not by typing a quantity",
        "The Leak Test and Barcode tabs are available",
      ]}
      whileOff={[
        "A tank is a quantity like every other component",
        "No serial, no leak test, no gate on painting",
        "The Leak Test and Barcode tabs are hidden",
        "Tanks already recorded stay saved and resume when you turn it back on",
      ]}
    />
  );
}
