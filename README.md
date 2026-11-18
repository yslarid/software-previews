# Software previews

Three decisions from my full-stack work, each with an interactive portfolio preview and an independently written, runnable example. The fixtures are fictional. The source includes no customer records, credentials or private application code.

## Dealer OS · did the invoice post?

Open the Ember Ridge invoice and reconcile its missing QuickBooks confirmation. Inspect the customer, invoice lines, tax and total before linking the provider record. Then switch to duplicate matches or a pre-write refusal and compare which actions become available.

The example stores approvals, versioned worker leases and an audit trail in SQLite. Its simulated accounting provider can commit a write and lose the response. Recovery queries for evidence. A worker that wakes up after recovery cannot overwrite the newer decision. The duplicate case requires an operator to select a matching provider record and record a reason.

[Open invoice control](https://williammazanik.com/dealer-os#preview) · [Inspect dispatch conflicts](https://williammazanik.com/dealer-os#dispatch) · [Read the annotated code](https://williammazanik.com/dealer-os#source) · [Journal source](./dealer-os.mjs) · [Failure tests](./dealer-os.test.mjs)

## AnimeHalo · which catalog release can go live?

Inject a provider rate limit during a catalog import. Observe the next eligible retry, finish the import and inspect which partitions changed before promotion. A separate failure case attempts to combine data from different source snapshots.

The importer validates whole provider responses, preserves a retry deadline in its checkpoint, and uses compare-and-swap when a worker commits progress. A release binds the source snapshot to its manifest. Changing one title can replace its partition while the previous release remains readable. The workbench runs the release algorithm against an in-memory store and scripted provider responses.

[Open the release workbench](https://williammazanik.com/animehalo#preview) · [Read the source explorer](https://williammazanik.com/animehalo#source) · [Release source](./animehalo.mjs) · [Release tests](./animehalo.test.mjs) · [Browse the live catalog](https://animehalo.com/list/best-anime)

## Jemparo · which subscription event controls access?

Open the delivery replay and send an older renewal after a cancellation. Try a duplicate delivery and inspect the entitlement and downstream notices. The product workspaces above the replay use fictional handoffs, closeouts and field records.

The example verifies a Stripe-style HMAC against the raw request body, then binds the test-mode event to a known account, customer and subscription. One SQLite transaction records the outcome, changes the entitlement and writes the outbox entry. The tests interrupt that transaction and reverse the delivery order of equal-timestamp events. Signatures and rollbacks run locally. The deliveries are generated fixtures.

[Explore the field workspaces](https://williammazanik.com/jemparo#preview) · [Open the delivery replay](https://williammazanik.com/jemparo#engineering) · [Read the source explorer](https://williammazanik.com/jemparo#source) · [Projection source](./jemparo.mjs) · [Delivery tests](./jemparo.test.mjs)

## Source

| Integration | What the adapter does | Source and tests |
| --- | --- | --- |
| AniList GraphQL | Reads public anime IDs in batches. An HTTP 200 with partial GraphQL errors leaves the checkpoint unchanged. A rate limit reschedules the page. The tests inject HTTP responses, and the optional probe calls the real endpoint for one public ID. | [Adapter](./anilist-provider.mjs) · [HTTP tests](./anilist-provider.test.mjs) · [Live probe](./probe-anilist.mjs) |
| QuickBooks Online sandbox | Uses scoped, read-only invoice queries, checks pagination, and translates complete CAD tax-exclusive sales-item invoices into evidence for the journal. Unsupported line shapes or partial responses block automatic reconciliation. Tests use HTTP fixtures. An authenticated sandbox run requires caller-supplied OAuth authorization. | [Adapter](./qbo-sandbox.mjs) · [HTTP and journal tests](./qbo-sandbox.test.mjs) |

## Run the tests

Use Node.js 24 or newer. All tests use the Node standard library and run offline.

```sh
node --test
```

To make one read-only request to AniList and build a release in memory, run the probe explicitly.

```sh
node probe-anilist.mjs --live 1
```

The earlier invoice-pricing, catalog-cache and customer-handoff examples keep their original module exports and [nine regression tests](./examples.test.mjs).

[William Mazanik’s portfolio](https://williammazanik.com/)
