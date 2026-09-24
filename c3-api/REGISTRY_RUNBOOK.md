# Comet registry runbook

For the person who brings the market registry up in an environment, or
switches it to a newer list of markets. You do not need to know how the
registry works inside; every step says what it is for, what to run, what you
should see, and what to do when you see something else.

The design behind it is in [README.md](./README.md#the-comet-market-registry),
and every route in [API.md](./API.md#registry-v1).

## The idea

The registry is the list of markets the API serves — their addresses,
tokens, prices, names, and which features each one has. A new list is never
edited in place. It is built as a **draft** (a "candidate version"), checked,
and only then **switched on** ("activated"). Until the switch, users see no
change at all, and after it, one command switches back.

## Before you start

- The environment's database has every migration applied, and this happened
  **before** the worker release that needs it:
  `npm run d1:migrate:stage` or `npm run d1:migrate:production`.
- The worker is deployed, and it reaches the node provider proxy.
- The environment has `COMET_REGISTRY_ADMIN_TOKEN_HASH` set, and you have the
  admin token itself — not its hash. See
  [The admin token](#the-admin-token) if the environment has none yet.

Nothing runs on your machine but the requests: the Worker being deployed
imports the source, proposes the decisions and applies them. For the terminal
commands:

```sh
export API=https://v3-api-stage.compound.xyz        # the environment you work on
export TOKEN='<admin token>'
```

Every step shows the terminal command, and beside it the same request for
Postman, written as the request itself: the method and URL on the first line,
then the headers, then the body. To use them:

- Create a Postman environment with the variables `API` (the environment's
  address, e.g. `https://v3-api-stage.compound.xyz`, or `http://localhost:8787`),
  `TOKEN` (the admin token) and `V` (the draft's id, filled in step 1).
- Send every administrative request with `Authorization: Bearer {{TOKEN}}` —
  or set **Authorization → Bearer Token → `{{TOKEN}}`** once on the collection
  and let the requests inherit it.
- A body is **Body → raw → JSON**. Postman then adds
  `Content-Type: application/json` itself.
- Postman shows the whole answer; each step says which fields to look at.

> **An environment that already serves users.** The market, account and
> history routes read their markets from the registry and answer `503` while
> no version is active. Do not let the release that reads from the registry go
> live in such an environment before a version is active there.

### The admin token

Every administrative route takes one bearer token per environment, and the
worker keeps only its SHA-256: what is configured cannot be used as the
token. Issue the token once, keep it in the team's password manager, and put
the hash — never the token — into the environment.

**1. Make a token.** 32 random bytes are plenty:

```sh
export TOKEN="$(openssl rand -hex 32)"
```

**2. Hash it.** Use `printf`, not `echo`: `echo` adds a newline, the newline
would be part of what is hashed, and the token you then send would not match.

```sh
printf '%s' "$TOKEN" | shasum -a 256 | cut -d ' ' -f 1
```

On Linux `sha256sum` reads the same way; `printf '%s' "$TOKEN" | openssl dgst -sha256 -r`
works anywhere OpenSSL does.

**3. Put the hash into the environment.** Wrangler prompts for the value and
stores it as a secret, so it never reaches the repository:

```sh
npx wrangler secret put COMET_REGISTRY_ADMIN_TOKEN_HASH --env stage
npx wrangler secret put COMET_REGISTRY_ADMIN_TOKEN_HASH --env production
```

For a worker you run on your own machine, the same line goes into `.dev.vars`,
which git ignores:

```
COMET_REGISTRY_ADMIN_TOKEN_HASH=<the hash from step 2>
```

**4. Check it** with any administrative read — an unknown version id is
enough, because reaching a `404` means the token was accepted:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  "$API/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000" \
  -H "Authorization: Bearer $TOKEN"
```

`404` is what you want. `401` means the hash in the environment is not this
token's — check for a stray newline in step 2. `403` means the environment
has no hash configured at all: an unconfigured admin API is a closed one.

**Rotating.** Repeat steps 1–3. The previous token stops working the moment
the secret is updated, without a deploy, so replace it in the password
manager first and tell whoever else holds it. There is one token per
environment: a stage token is not a production one.

## Bringing an environment up for the first time

### 1. Import — take a snapshot of the source

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq
export V=<registryVersionId from the answer>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{}
```

Copy `registryVersionId` from the answer into the `V` variable — or let
Postman do it, with this under **Scripts → Post-response**:

```js
const id = pm.response.json().registryVersionId;
if (id) pm.environment.set('V', id);
```

**Why.** The registry reads the list of markets from Compound's official
repository at one exact commit, and reads from the blockchain everything the
chain can confirm: addresses, tokens, price feeds. The result is the draft.

What the chain cannot say — what a market is called, whether it is offered,
which features it has — is a human decision. On the first import there is no
earlier version to take those decisions from, so every market arrives
**switched off and unreviewed**, and the draft is **held**: nothing is decided
for you.

**You should see** `"status": "completed"` and `"heldForReview": true`.
`"checksFailed"` counts the checks the draft does not pass yet: on a first
import it is never zero, because nothing has been reviewed — the missing
default market alone is one of them. You work it down in the steps below.

**If not.** `"status": "running"` means the import has more to do: send the
same request **with an empty body** (`{}`) and repeat until it answers
`"completed"`. The answer says how far it has got —

```json
{ "status": "running", "expected": 29, "completed": 23, "outstanding": 6 }
```

— where `expected` is how many markets the source has, `completed` how many
are imported, and `outstanding` how many are still to try. A market the chain
did not answer for goes back into the queue and is tried again by the next
request, so the number each request gets through varies. Which markets are
left, and why, is in `GET /registry/v1/admin/sync-runs/<syncRunId>`.

One request imports as many markets as fit in a single Worker invocation.
Locally that is usually the whole source at once; a deployed Worker is given
less, so the markets it does not reach fail — without being held against
them — and the next request picks them up. Repeating the request is the whole
procedure; there is nothing to tune.

Do not repeat the request with `forceNewAttempt` or `holdForReview` while it
is running: those decisions belong to the run that is already in progress, so
the request is refused with `409` rather than quietly ignoring them. An error
means the import could not finish; see
[When something goes wrong](#when-something-goes-wrong).

### 2. Read what the release proposes

```sh
curl -s "$API/registry/v1/admin/versions/$V/proposal/review" -H "Authorization: Bearer $TOKEN"
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/proposal/review
Authorization: Bearer {{TOKEN}}
```

**Why.** This is the human check. The Worker writes down, for the markets the
draft imported, the decisions the API and the website already act on today —
names, features, which feed prices what — as a document to read, with where
each kind of value came from. It changes nothing.

**You should see** "Nothing." under **Needs a decision**, and a **Digest**
near the top — note it for the next step. Skim the tables.

**If not.** A market listed under "Needs a decision" is one the constants do
not describe. It is not proposed, and stays switched off; the rest can be
applied without it, and it is described afterwards — see
[Describing a new market](#describing-a-new-market). A value that is wrong is
corrected by a developer in the tables of `src/registry/bootstrap.ts`, and
the release that carries the correction proposes it.

The same proposal as data, with the digest and the documents it would write,
is `GET {{API}}/registry/v1/admin/versions/{{V}}/proposal`.

### 3. Apply it

```sh
curl -s -X POST "$API/registry/v1/admin/versions/$V/proposal/apply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "first registry version", "digest": "<digest from the review>"}' | jq '{changed, unreviewed}'
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/proposal/apply
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "first registry version", "digest": "<digest from the review>"}
```

**Why.** The Worker builds the proposal again and writes it into the draft
only if it is still the one with that digest — exactly what you read. It is
all or nothing: if any part is refused, nothing is written. Users still see
no change.

**You should see** `"changed": true`, and `unreviewed` empty — or holding only
the markets listed under "Needs a decision".

**If not.** A `409` naming another digest means the proposal changed since you
read it — another release was deployed, or another draft is being read. Read
the review again. Applying the same digest twice is safe: it answers
`"changed": false`.

### 4. Let the registry check the draft

```sh
curl -s -X POST "$API/registry/v1/admin/versions/$V/validate" \
  -H "Authorization: Bearer $TOKEN" | jq '{status: .version.status}'
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/validate
Authorization: Bearer {{TOKEN}}
```

No body: the check decides nothing, so it takes no reason. In the answer,
look at `version.status`.

**Why.** The registry checks that the draft holds together: exactly one
market opens by default, every market that is offered has what it needs to
price its assets and rewards, no two markets could be confused on the
website. A draft that passes is **frozen**: nothing can change it any more.

**You should see** `"status": "validated"`.

**If not.** `"invalid"` means a check failed. Collect the reasons and pass
them to a developer:

```sh
curl -s "$API/registry/v1/admin/versions/$V" -H "Authorization: Bearer $TOKEN" | jq .validation
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}
Authorization: Bearer {{TOKEN}}
```

The reasons are under `validation` in the answer.

A frozen draft cannot be fixed. Once the cause is fixed, start a new attempt
(step 1 with `{"forceNewAttempt": true, "holdForReview": true, "reason": "..."}`);
it keeps everything already reviewed, so steps 2 and 3 only change what was
wrong.

### 5. Compare with what the API uses today

```sh
curl -s "$API/registry/v1/admin/versions/$V/shadow" -H "Authorization: Bearer $TOKEN" \
  | jq '{onlyInStatic: .shadow.onlyInStatic, onlyInRegistry: .shadow.onlyInRegistry,
         differences: [.shadow.differences[] | "\(.scope) \(.field)"]}'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/shadow
Authorization: Bearer {{TOKEN}}
```

In the answer, look at `shadow.onlyInStatic`, `shadow.onlyInRegistry` and
`shadow.differences` — each difference names its `scope` and `field`.

**Why.** The last check before users see anything. It compares the draft
with the market list written into the API's code, which is what the API
served before the registry. That makes it the check for moving an environment
onto the registry: it shows that every market the API served comes across
with the same addresses and feeds, or says why not. It knows nothing about a
market the code does not describe.

**You should see** empty `onlyInStatic` and `onlyInRegistry`, and exactly the
differences listed in [Known differences](#known-differences). They are
expected: the code is out of date in those places, and the draft took the
blockchain's answer.

**If not.** Anything else — a market missing on either side, a field not in
the list — **do not switch on.** Show the output to a developer.

### 6. Switch it on

```sh
curl -s -X POST "$API/registry/v1/admin/versions/$V/activate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"first registry version"}' | jq
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/activate
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "first registry version"}
```

**Why.** The API moves to the new list in one step. This is the only step
users notice. It is recorded with your reason, and can be undone — see
[Switching back](#switching-back).

### 7. Check that it is on

```sh
curl -s "$API/registry/v1/active" | jq '[.networks[].markets | length] | add'
curl -si "$API/market/ethereum-mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary" | grep -i x-registry-version
```

Postman:

```http
GET {{API}}/registry/v1/active

GET {{API}}/market/ethereum-mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary
```

Neither needs the token. In the first answer, count the markets under
`networks[].markets`; in the second, the `X-Registry-Version` response header
is on the **Headers** tab.

**You should see** the number of markets you reviewed, and a
`X-Registry-Version` header equal to `$V`.

## When the source changes

Nothing needs doing to pick up a new commit. The scheduled job looks for one
once a day, imports it over the following hours, takes every decision from
the version that is on, and checks the result. Switching it on is always a
person's decision.

### 1. Find the draft

Every version there is, newest first, with the one that is on named:

```sh
curl -s "$API/registry/v1/admin/versions" -H "Authorization: Bearer $TOKEN" | jq
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions
Authorization: Bearer {{TOKEN}}
```

`?status=importing` narrows it to the drafts still open — usually the one you
are looking for. Put its `id` in `V`.

Send the import request. While an import runs, and once the newest commit is
imported, the answer names the draft in `registryVersionId`:

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq '{status, outcome, registryVersionId, reason}'
export V=<registryVersionId>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{}
```

Look at `status`, `outcome`, `registryVersionId` and `reason`. For a
particular commit, the body is `{"sourceCommitSha": "<commit>", "reason": "..."}`.

An answer of `upstream was checked recently` names no draft. To ask about a
particular commit instead, send `{"sourceCommitSha": "<commit>", "reason": "..."}`:
it answers with that commit's draft, importing it first if there is none.

### 2. See what switching it on would change

```sh
curl -s "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '{status, comparedWith, added: [.markets.added[] | {scope, reviewed}], removed: .markets.removed,
         changed: [.markets.changed[] | "\(.scope) \(.field): \(.before) -> \(.after)"], networks}'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/changes
Authorization: Bearer {{TOKEN}}
```

Look at `markets.added` (each with `scope` and `reviewed`), `markets.removed`,
and `markets.changed` — each change names its `scope`, `field`, `before` and
`after`. `networks` has the same three lists for networks.

**Why.** This compares the draft with the version that is on — not with the
API's code — so it shows everything the new commit changes.

**You should see** the markets the commit adds and drops, and every field that
differs on the others.

- A market under `added` with `"reviewed": false` is one the source has added.
  It is switched off, and the draft can be switched on without it; to offer it,
  see [Describing a new market](#describing-a-new-market).
- A market under `removed` stops being served once the draft is on. That is
  worth a developer's confirmation.
- A changed feed, contract, token or collateral on a market that stays is the
  commit changing that market. If nobody expected it, show it to a developer
  before switching on.

### 3. Switch it on

Steps 6 and 7 above for the draft. Step 5 (`shadow`) still compares with the
API's code, and while that code exists it is worth a look: a difference not
in [Known differences](#known-differences) on a market the code describes is
the commit changing that market. It cannot say anything about a market the
code does not describe.

## Describing a new market

A market the source adds arrives switched off and unreviewed, and nothing
serves it until someone describes it. Describing it is writing down the
decisions about it, in one document.

### 1. Hold a draft that includes it

The scheduled job's draft of a commit is checked and frozen as soon as it is
imported, so describing a market needs a new attempt of that commit, held open:

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"forceNewAttempt": true, "holdForReview": true, "reason": "describe <chainId>/<deploymentKey>"}' | jq
export V=<registryVersionId>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"forceNewAttempt": true, "holdForReview": true, "reason": "describe <chainId>/<deploymentKey>"}
```

Copy `registryVersionId` into `V`, or keep the post-response script from the
first bring-up on this request too.

The new attempt keeps every decision already made, so only the new market
is left unreviewed.

### 2. See what the import read about it

```sh
curl -s "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '.markets.added[] | select(.reviewed | not)'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/changes
Authorization: Bearer {{TOKEN}}
```

The new market is the entry of `markets.added` with `"reviewed": false`; its
facts are under `market`.

This is everything the source and the chain say about the market: its Comet
and other contracts, its base token and that token's price feed, its reward
token if it has rewards, and its collateral. The decisions come next.

### 3. Start from a similar market

A market of the same network with the same kind of base asset usually shares
most decisions — the reward feed, the quote unit, the USD feed. Read its
document:

```sh
curl -s "$API/registry/v1/admin/versions/$V/markets/<chainId>/<similar deploymentKey>/overlay" \
  -H "Authorization: Bearer $TOKEN" | jq .overlay
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/markets/<chainId>/<similar deploymentKey>/overlay
Authorization: Bearer {{TOKEN}}
```

Copy the `overlay` object from the answer: it is what step 5 sends, once the
fields below are decided.

### 4. Decide every field

| Field | What it is | Where the answer comes from |
|---|---|---|
| `displayName` | The market's label on the website: `USDC`, `ETH` for a WETH market, `USDC.e` | Agree it with the frontend developer: the website builds its market key from it |
| `baseAsset.displayName` | The base asset's name on the website: `USD Coin`, `Ether`, `Tether` | The same |
| `slug` | The market's key in the website's links | `null`, unless another market of the network that is not switched off has the same label; then a unique lowercase key such as `usdc-institutional` |
| `isInstitutional` | Listed in the website's institutional section | Usually `false` |
| `contractName` | The Comet's name, shown in governance action titles | The Comet contract's `symbol()`, for example `cUSDTv3` |
| `status` | Whether the market is served | `enabled`; `disabled` keeps it off |
| `isDefault` | The market the website opens first | `false` — exactly one market in the whole registry is the default |
| `creationBlock` | Where the market's history and indexes start | The block the Comet proxy was deployed in (the explorer's "Contract Creation"). Must be above `0` for a market that is served |
| `collateralValueQuote` | The unit the market's own price feeds answer in | Call `description()` on the base token's price feed from step 2. `X / USD` → `usd`. `Constant price feed` (WETH, wstETH) or `WBTC / BTC` → `base` |
| `baseAsset.usdPriceFeedAddress` | The feed that turns the base asset into USD | `null` when the quote is `usd`. When it is `base`, the base asset's USD feed on that chain — for a WETH market, ETH / USD |
| `baseAsset.isWrappedNative` | The base token wraps the chain's own token | `true` for WETH on Ethereum and its L2s, WPOL, WMNT, WRON |
| `capabilities.rewards`, `capabilities.accountRewards`, `rewardPriceFeed` | Rewards | If step 2 shows no reward token, the market has no rewards: both `false`, `rewardPriceFeed` `null`. Otherwise the COMP price feed of that chain, `"quote": "usd"`, as the similar market has it |
| `capabilities.transactionHistory` | Whether the market appears in users' transaction history | `true` if it should. The market needs a rewards contract, and a right `creationBlock` |

The document is complete or it is refused: a missing field is a decision
nobody made, not a default. The checks in step 4 of the first bring-up refuse
the combinations that cannot work — a `base` quote without a USD feed,
rewards without a feed, a shared label without a slug, a served market
without a creation block — and a reward feed on a market with no reward
token is refused as soon as it is sent.

### 5. Send it, then check and switch on

```sh
curl -s -X PUT "$API/registry/v1/admin/versions/$V/markets/<chainId>/<deploymentKey>/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "describe <chainId>/<deploymentKey>", "overlay": { ... }}' | jq
```

Postman:

```http
PUT {{API}}/registry/v1/admin/versions/{{V}}/markets/<chainId>/<deploymentKey>/overlay
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{
  "reason": "describe <chainId>/<deploymentKey>",
  "overlay": {
    "displayName": "USDC",
    "slug": null,
    "contractName": "cUSDCv3",
    "isDefault": false,
    "isInstitutional": false,
    "status": "enabled",
    "creationBlock": 11699480,
    "collateralValueQuote": "usd",
    "capabilities": { "rewards": true, "accountRewards": true, "transactionHistory": true },
    "baseAsset": { "displayName": "USD Coin", "isWrappedNative": false, "usdPriceFeedAddress": null },
    "rewardPriceFeed": { "address": "0x9dda783de64a9d1a60c49ca761ebe528c35ba428", "quote": "usd" }
  }
}
```

The overlay above is Base USDC's, as step 3 reads it; replace it with the
new market's decided fields.

Then steps 4, 6 and 7 of the first bring-up, and step 2 above for what the
draft changes. The new market is under `added`, now with `"reviewed": true`.

## A market that stopped answering

A market whose price feed reverts is reported with `"status": "partially"`
(a collateral's feed) or `"status": "error"` (its base or reward feed) until
a version says how to price what broke — see
[Market status](./API.md#market-status). Almost always it is a feed Chainlink
retired: the Comet reads it through `getPrice`, which reverts with it.

### 1. Find the feed

A read that reverts logs one line (`npx wrangler tail --env production`, or
the worker's logs in the Cloudflare dashboard). A summary logs the feed:

```
price feed reverted: 0xe3a409ed15cd53afdefdd191ad945cec528a2496 read by 0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840 on ethereum-mainnet at block 23400000: execution reverted
```

The rewards routes log the market and the call:

```
market call reverted: 1/usdt on ethereum-mainnet (0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840): call to 0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840 with 0x41976e09000000000000000000000000e3a409ed15cd53afdefdd191ad945cec528a2496 reverted at block 23400000: execution reverted
```

There `0x41976e09` is `getPrice`, and the last 40 hex digits are the feed.
The market's `collateralAssets` in
`GET /registry/v1/networks/<chainId>/markets/<comet>` say which asset reads
it.

A price exception covers collateral feeds only. When the feed is the market's
base feed, the Comet itself cannot price its base asset and only its
governance can replace the feed. A reward feed or a base USD feed is changed
in the market's overlay instead (`rewardPriceFeed`,
`baseAsset.usdPriceFeedAddress`): hold a draft as in step 1 of
[Describing a new market](#describing-a-new-market), read the market's own
overlay with `GET …/markets/<chainId>/<deploymentKey>/overlay`, and send it
back changed as in its step 5.

### 2. Decide how to price it

| Kind | Use it when | What it needs |
|---|---|---|
| `deprecated_price_remap` | Another feed answers the same pair | `replacementPriceFeedAddress`; the registry reads its decimals on chain |
| `fixed_price` | The asset keeps a value but no feed answers any more | `price.value`, the feed's last answer as an integer string, and `price.decimals`, the feed's scale |
| `zero_price` | The asset is being wound down and should count for nothing | Nothing more |

The `provenance` of each says what broke and why this price: it is what the
next operator reads.

### 3. Hold a draft and write the exception

Step 1 of [Describing a new market](#describing-a-new-market) holds the
draft. A network overlay is replaced as a whole, so start from the one the
active version has:

```sh
curl -s "$API/registry/v1/networks" | jq '.networks[] | select(.chainId == 1) | {
  displayName,
  assetDisplayOverrides:     .presentation.assetDisplayOverrides,
  unwrappedCollateralAssets: .presentation.unwrappedCollateralAssets,
  priceExceptions: [ .priceExceptions[] | if .kind == "deprecated_price_remap"
    then (. + { replacementPriceFeedAddress: .replacementPriceFeed.address } | del(.replacementPriceFeed))
    else . end ]
}' > overlay.json

jq '.priceExceptions += [{
  "kind": "zero_price",
  "priceFeedAddress": "0xe3a409ed15cd53afdefdd191ad945cec528a2496",
  "provenance": "wUSDM / USD (cUSDTv3 collateral) reverts since <date>; <why this price>",
  "expiresAt": null
}]' overlay.json > overlay.next.json

curl -s -X PUT "$API/registry/v1/admin/versions/$V/networks/1/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq '{ reason: "price the feed 1/usdt reads, which reverts", overlay: . }' overlay.next.json)" | jq
```

Postman:

```http
PUT {{API}}/registry/v1/admin/versions/{{V}}/networks/1/overlay
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{
  "reason": "price the feed 1/usdt reads, which reverts",
  "overlay": <the contents of overlay.next.json>
}
```

**You should see** `"changed": true`.

### 4. Check and switch on

Steps 4, 6 and 7 of the first bring-up. The market reports `success` from
the first request after the switch: the exception changes what its summaries
are cached under.

`GET /registry/v1/admin/status` does not report a market whose feed reverts:
alert on the `price feed reverted:` and `market call reverted:` log lines
instead.

## Switching back

```sh
curl -s -X POST "$API/registry/v1/admin/versions/<previous version id>/rollback" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"why"}' | jq
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/<previous version id>/rollback
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "why"}
```

The id is the version to go **back to**, which must have been validated. It
is the `previousVersionId` in the answer of the activation you are undoing,
and it is also in the activation history that
`GET /registry/v1/admin/versions/<the version that is on>` lists.

## Keeping an eye on it

One request tells you whether the registry is well:

```sh
curl -s "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq
```

Postman:

```http
GET {{API}}/registry/v1/admin/status
Authorization: Bearer {{TOKEN}}
```

**You should see** `"alerts": []`. Everything else in the answer is context:
which version is on and who switched it on, whether its data is cached, when
the source was last checked, how the last import went, and which drafts are
still open.

When `alerts` is not empty, each name says what to do:

| Alert | What it means | What to do |
|---|---|---|
| `no-active-version` | Nothing is switched on, so every market route answers `503` | Bring a version up — [Bringing an environment up for the first time](#bringing-an-environment-up-for-the-first-time) |
| `candidate-awaiting-review` | A draft is waiting and no import is running | Review it, or switch it on — [When the source changes](#when-the-source-changes) |
| `last-sync-failed` | The last import failed | Read its run: `GET /registry/v1/admin/sync-runs/<id>` tells you which root failed and why |
| `sync-stalled` | A run says it is running, but nobody is continuing it | The hourly import resumes it by itself; if the alert stays for hours, look at the worker's logs |
| `sync-overdue` | The source has not been checked for more than two days | The hourly trigger is not firing, or every invocation fails before it records a check |
| `snapshot-not-cached` | The active version is not in the cache | Harmless by itself — the next request refills it. If it persists, the KV namespace is misconfigured for this environment |
| `cache-unreadable` | The KV namespace itself did not answer | Check the `kv_registry` binding of this environment: until it answers there is no cache, and no older version to fall back on if the database fails |

This is the request to point a monitor at: poll it every few minutes and
alert when `alerts` is not empty, or when the request itself fails.

## Known differences

What `shadow` reports for a registry bootstrapped from
`Compound-Foundation/comet@a34d9b571c83`. Each is a place where the market
list in the API's code is out of date, and the registry has the blockchain's
answer.

| Difference | Why it is expected |
|---|---|
| `1/institutional_usdc rewards.asset`, `rewards.contract`, `rewards.priceFeed` | The market has no rewards configured on chain; the code declares COMP rewards for it as a placeholder |
| `2020/weth` and `2020/wron` `rewards.asset`, `rewards.priceFeed` | No rewards are configured on Ronin; the code declares placeholders |
| `534352/usdc rewards.priceFeed` | Scroll has no COMP price feed; the code points at the market's own base feed |
| `1/wbtc baseAsset.priceFeed`, `baseAsset.usdPriceFeed` | The market prices in BTC through its own WBTC/BTC feed; the code flattens it onto BTC/USD |
| `8453/aero baseAsset.priceFeed`, `baseAsset.usdPriceFeed` | The market's feed already answers AERO / USD; the code gives it the USDC feed |
| `42161/usdc`, `42161/usdt`, `8453/usdc` `baseAsset.priceFeed` | These markets moved to newer (SVR) price feeds; the code has the old ones |
| `5000/usde baseAsset.priceFeed`, `baseAsset.priceFeedDecimals` | The market reads a USDe / USD feed with 8 decimals; the code has another USDe / USD feed with 18 |
| `137/usdt`, `42161/usdt` `baseAsset.symbol` | Tether renamed USDT to USDT0 and USD₮0 on these chains |
| `42161/usdc.e baseAsset.symbol` | Bridged USDC calls itself USDC on chain; the code calls it USDC.e |

A newer commit, or a change to the code's market list, can change this list.
A difference not in it is worth a developer's look before switching on.

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `UPSTREAM_UNAVAILABLE: an unexpected error interrupted the import` | Usually the environment's database has no migrations applied | Apply the migrations, then import again |
| `CHAIN_REQUEST_FAILED` in the import | The worker cannot reach the node provider proxy | Fix the proxy or its binding; importing again continues where it stopped |
| `401` | The token is wrong, or is the hash | Use the admin token itself |
| `429` | More than 30 administrative writes in a minute | Wait a minute |
| `409` writing overlays | The draft is no longer open: it was validated or switched on | Start a new attempt (step 1 with `forceNewAttempt`) |
| `409` on apply, naming another digest | The proposal changed since you read it | Read the review again, and apply its digest |
| `409` on validate, "the import … is still running" | The import has not finished | Send step 1 again until it completes |
| `idle` from import, "a candidate of this commit is held for review" | A draft of this commit is already waiting for you | Use that draft — its id is in the answer — or force a new attempt |
| `409 SYNC_ALREADY_RUNNING` | An import is in progress — the hourly one, a request you already sent, or one you are asking to change with `forceNewAttempt`, `holdForReview` or `sourceCommitSha` | Continue it with an empty body until it says `completed`; only then ask for a new attempt |
| A market reports `"status": "partially"` or `"status": "error"` | A price feed it reads reverts, usually one Chainlink retired | [A market that stopped answering](#a-market-that-stopped-answering) |
| Answers carry `X-Registry-Stale: <seconds>` | The database could not be reached, so the API is answering from the version it last saw, and saying how old it is | Check the database's health; the API recovers by itself once D1 answers, and starts returning `503` if the outage outlasts the configured window |
