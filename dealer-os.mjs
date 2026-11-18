// A quote and its invoice must agree on the value of each fractional line.
// Use integers throughout: quantity in thousandths of a unit and rate in cents.
export function priceLine(quantityThousandths, unitPriceCents) {
  if (typeof quantityThousandths !== "bigint" || typeof unitPriceCents !== "bigint") {
    throw new TypeError("Supply the quantity and unit price as bigint integers.");
  }

  const thousandthsOfACent = quantityThousandths * unitPriceCents;
  // BigInt division truncates toward zero. Half a cent rounds away from zero
  // for a charge and for the matching credit.
  const halfCent = thousandthsOfACent < 0n ? -500n : 500n;
  return (thousandthsOfACent + halfCent) / 1000n;
}

export function subtotal(lines) {
  return lines.reduce(
    (sum, line) => sum + priceLine(line.quantityThousandths, line.unitPriceCents),
    0n,
  );
}
