// Display-layer unit conversion. STORAGE AND MATH ARE ALWAYS METRIC — these helpers
// exist only at the render/parse boundary, so no calculation ever branches on units.

const KG_PER_LB = 0.45359237;

export const kgToLb = (kg) => kg / KG_PER_LB;
export const lbToKg = (lb) => lb * KG_PER_LB;

export function formatWeight(kg, units, decimals = 1) {
  if (kg == null || !Number.isFinite(Number(kg))) return "—";
  const v = units === "imperial" ? kgToLb(Number(kg)) : Number(kg);
  return v.toFixed(decimals);
}

export const weightUnit = (units) => (units === "imperial" ? "lb" : "kg");

// Free-text weight input in the user's display unit -> kg for storage.
export function parseWeightInput(str, units) {
  const v = parseFloat(String(str ?? "").replace(",", "."));
  if (!Number.isFinite(v)) return null;
  return units === "imperial" ? lbToKg(v) : v;
}

// Sanity bounds for the weigh-in field, in kg (the stored unit). The old hardcoded
// 30–250 check silently accepted a lb-thinking user typing 185 and stored 185 kg.
export function weightBoundsKg() {
  return { min: 30, max: 250 };
}

export function validWeightKg(kg) {
  if (kg == null || !Number.isFinite(kg)) return false;
  const { min, max } = weightBoundsKg();
  return kg >= min && kg <= max;
}

/* ---------------- height ---------------- */

export function cmToFtIn(cm) {
  const totalIn = Number(cm) / 2.54;
  const ft = Math.floor(totalIn / 12);
  return { ft, inch: Math.round(totalIn - ft * 12) };
}

export function ftInToCm(ft, inch) {
  const f = Number(ft) || 0;
  const i = Number(inch) || 0;
  return Math.round((f * 12 + i) * 2.54 * 10) / 10;
}

export function formatHeight(cm, units) {
  if (cm == null || !Number.isFinite(Number(cm))) return "—";
  if (units === "imperial") {
    const { ft, inch } = cmToFtIn(cm);
    return `${ft}′${inch}″`;
  }
  return `${Math.round(cm)} cm`;
}
