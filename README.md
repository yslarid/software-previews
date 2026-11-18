# Software previews

Three engineering decisions from my full-stack development work. I wrote these small, standalone examples for this portfolio using fictional data. Each one has runnable tests.

## Dealer OS

A construction quote can include fractional labour hours. At $19.99 per hour, 1.5 hours costs $29.985 before rounding. The invoice should show $29.99, and the corresponding credit should reverse that amount exactly. The example represents quantities in thousandths and prices in cents. It rounds once per line and totals the amounts the customer sees.

[Read the code](./dealer-os.mjs) · [Explore the Dealer OS preview](https://williammazanik.com/dealer-os#preview)

## AnimeHalo

Changing one title in a large catalog should let visitors reuse cached data for the rest. The example maps fictional titles to four stable buckets. Each filename contains a digest of its contents. A title edit changes one bucket URL, and a detail page can locate the relevant file from the title ID and manifest.

[Read the code](./animehalo.mjs) · [Explore the AnimeHalo preview](https://williammazanik.com/animehalo) · [Open the live catalog](https://animehalo.com/list/best-anime)

## Jemparo · SetAhead

A delivery booked for a day has a different meaning from a confirmed two-hour window. The readiness card preserves that distinction when preparing a customer handoff. It includes a site note only when someone explicitly chooses to share it.

[Read the code](./jemparo.mjs) · [Explore the Jemparo previews](https://williammazanik.com/jemparo#preview)

## Run the examples

With Node.js 20 or later, run the tests from the repository root.

```sh
node --test examples.test.mjs
```

[Read the tests](./examples.test.mjs) · [William Mazanik’s portfolio](https://williammazanik.com/)
