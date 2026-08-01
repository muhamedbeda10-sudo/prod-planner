/* Calibrating the standard times against the plant's OWN pace.
 *
 * The admin records how many man-hours a stage actually worked each day.
 * The ledger already says how many std-hours that day's output was worth.
 * If a stage keeps earning 80 std-hours out of every 100 it works, the
 * standards are 25% too tight — multiplying that stage's class hours by
 * actual/earned makes future earned hours track the real effort.
 */

/** One recorded day for one stage: what it worked vs what its output earned. */
export interface CalibrationDay {
  actual: number; // man-hours the admin recorded
  earned: number; // std-hours the ledger's output priced to
}

export interface CalibrationSummary {
  days: number; // recorded days that count (actual > 0)
  actualH: number;
  earnedH: number;
  efficiency: number | null; // earned / actual — null until it can be trusted
  factor: number | null; // actual / earned — multiply the stage's std hours by this
  ready: boolean; // enough data for the one-click apply
  reason: string | null; // why not ready, for the UI
}

/** Days below this and the suggestion stays locked — a two-day sample says
 *  more about which orders happened to run than about the crew. */
export const MIN_CALIBRATION_DAYS = 5;

/** Outside this band the mismatch is almost certainly a recording problem
 *  (hours logged against the wrong stage, output never entered), not a pace
 *  finding — applying it would wreck every figure in the app. */
export const FACTOR_MIN = 0.33;
export const FACTOR_MAX = 3;

export function calibrate(days: CalibrationDay[]): CalibrationSummary {
  const counted = days.filter((d) => d.actual > 0);
  const actualH = counted.reduce((a, d) => a + d.actual, 0);
  const earnedH = counted.reduce((a, d) => a + d.earned, 0);

  const base = { days: counted.length, actualH, earnedH };
  if (counted.length < MIN_CALIBRATION_DAYS) {
    return {
      ...base, efficiency: null, factor: null, ready: false,
      reason: `needs ${MIN_CALIBRATION_DAYS} recorded days (has ${counted.length})`,
    };
  }
  if (earnedH <= 0) {
    return {
      ...base, efficiency: null, factor: null, ready: false,
      reason: "no output recorded on those days — nothing to compare against",
    };
  }
  const efficiency = earnedH / actualH;
  const factor = actualH / earnedH;
  if (factor < FACTOR_MIN || factor > FACTOR_MAX) {
    return {
      ...base, efficiency, factor, ready: false,
      reason: "the gap is too large to be a pace finding — check the recorded hours and the ledger first",
    };
  }
  return { ...base, efficiency, factor, ready: true, reason: null };
}
