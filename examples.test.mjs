import assert from "node:assert/strict";
import test from "node:test";
import { priceLine, subtotal } from "./dealer-os.mjs";
import { buildCatalog, chunkPath } from "./animehalo.mjs";
import { readinessCard } from "./jemparo.mjs";

test("a half-cent charge and its credit cancel exactly", () => {
  assert.equal(priceLine(1500n, 1999n), 2999n);
  assert.equal(priceLine(1500n, -1999n), -2999n);
  assert.equal(priceLine(249n, 2n), 0n);
  assert.throws(() => priceLine(1.5, 1999n), TypeError);
});

test("a quote subtotal sums the displayed, individually rounded line amounts", () => {
  const line = { quantityThousandths: 500n, unitPriceCents: 1n };
  assert.equal(subtotal([line, line]), 2n);
  assert.equal(subtotal([]), 0n);
});

const titles = [
  { id: "a1", title: "Winter Observatory" },
  { id: "a2", title: "Night Orchard" },
  { id: "a3", title: "Signal Station" },
];

test("a title ID resolves to a single chunk that contains its record", () => {
  const { manifest, files } = buildCatalog(titles);
  for (const record of titles) {
    const contents = JSON.parse(files.get(chunkPath(manifest, record.id)));
    assert.deepEqual(contents.find(row => row.id === record.id), record);
  }
});

test("reordering input preserves every URL and editing a title changes one bucket", () => {
  const first = buildCatalog(titles).manifest;
  assert.deepEqual(buildCatalog([...titles].reverse()).manifest, first);
  const edited = titles.map(row => row.id === "a2" ? { ...row, title: "Autumn Orchard" } : row);
  const second = buildCatalog(edited).manifest;
  assert.equal(second.filter((url, i) => url !== first[i]).length, 1);
  assert.notEqual(chunkPath(first, "a2"), chunkPath(second, "a2"));
});

test("an ambiguous catalog ID fails the build", () => {
  assert.throws(() => buildCatalog([titles[0], titles[0]]), /Duplicate catalog ID/);
});

const booking = {
  reference: "Demo 801",
  timing: { kind: "date", date: "2027-03-14" },
  siteNote: "Meet the driver at the sample gate.",
  internalMemo: "Fictional office-only note.",
};

test("a date-only visit acquires no appointment time or internal fields", () => {
  assert.deepEqual(readinessCard(booking), { reference: "Demo 801", timing: "2027-03-14" });
});

test("a shared site note can be explicitly included while other notes stay private", () => {
  const card = readinessCard(booking, { shareNote: true });
  assert.equal(card.siteNote, booking.siteNote);
  assert.equal(Object.hasOwn(card, "internalMemo"), false);
  assert.equal(Object.hasOwn(readinessCard(booking, { shareNote: "false" }), "siteNote"), false);
});

test("a confirmed window and an office-confirmed visit have distinct wording", () => {
  const timing = { kind: "window", date: "2027-03-14", start: "09:00", end: "11:00" };
  assert.match(readinessCard({ ...booking, timing }).timing, /09:00–11:00 local time/);
  assert.equal(readinessCard({ ...booking, timing: { kind: "office-confirms" } }).timing,
    "The office will confirm timing.");
});

test("invalid calendar dates and backwards windows are rejected", () => {
  assert.throws(() => readinessCard({ ...booking, timing: { kind: "date", date: "2027-02-29" } }), RangeError);
  const timing = { kind: "window", date: "2027-03-14", start: "11:00", end: "10:00" };
  assert.throws(() => readinessCard({ ...booking, timing }), RangeError);
});
