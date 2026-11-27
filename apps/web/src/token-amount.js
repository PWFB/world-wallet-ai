// Format non-negative token decimal strings without IEEE-754 conversion.
export function formatTokenAmountExact(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) return "Unavailable";
  const [whole, fraction = ""] = raw.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return groupedWhole + (trimmedFraction ? "." + trimmedFraction : "");
}
