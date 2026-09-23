# Endpoints

## The market registry

Markets, tokens, and price feeds come from one activated registry version.
Every response whose content depends on it carries the version that answered:

```
X-Registry-Version:  8f1e0f3c-3b7a-4e8f-9a1b-1f0f0b9a2c44
X-Registry-Checksum: 1bd74ebe00d845e0fa5e648b22a2c39e60d9a62bf6c58190320fa01cd9a26a4a
```

Endpoints that resolve a market answer `503` when no version is active, and
`400` for an address the active version does not describe. The registry's own
endpoints are documented under [Registry v1](#registry-v1).

## Pagination

Many endpoints are paginated for convenience. If an endpoint is paginated,
responses will include a `pagination_summary` about the returned page.

Clients can control pagination using query parameters:
- `page_size`   - [optional] - [default if not specified: 100]
- `page_number` - [optional] - [default 1]

Clients can navigate to the next page of a response by adding a
querystring like `?page_number=${response.page_number + 1}` to an
endpoint and `GET`ting it again.

## `/market/{network}/{address}/summary`
### description:

Point-in-time summary at the current block of various market statistics:
- Total collateral value (in USD)
- Total borrow value (in USD)
- Borrow APR
- Supply APR

```sh
$ curl 'localhost:8787/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary'
```
```json
{
  "date": "2022-09-12",
  "timestamp": 1663006848,
  "total_collateral_value": "736406396.32667881067597418742582842",
  "total_borrow_value": "291934.5637828698",
  "borrow_apr": "0.024456245200128",
  "supply_apr": "0.008780799134304"
}
```

## `/market/{network}/{address}/historical/summary`
### description:

30 days of historical `/summary`s, starting from the current day, sampling
a single block per-day.

```sh
$ curl 'localhost:8787/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/historical/summary'
```
```json
[
  {
    "date": "2022-09-12",
    "timestamp": 1663006848,
    "total_collateral_value": "736406396.32667881067597418742582842",
    "total_borrow_value": "291934.5637828698",
    "borrow_apr": "0.024456245200128",
    "supply_apr": "0.008780799134304"
  },
  ...,
  {
    "date": "2022-08-14",
    "timestamp": 1660504680,
    "total_collateral_value": "0.0",
    "total_borrow_value": "0.0",
    "borrow_apr": "0.014999999976144",
    "supply_apr": "0.0"
  }
]
```

## `/market/{network}/{address}/rewards/summary`
### description:

Point-in-time summary at the most-recently-sampled block (which may not be
the 'latest' block per se) of rewards rates and APRs for a v3 market.

A market the active registry version gives no rewards — the Scroll and Ronin
markets, and a Comet with no rewards configured, such as mainnet ciUSDCv3 —
answers `404` rather than a summary, because there is no reward price to
value its rewards with:

```json
{ "error": "Rewards are not available for this market", "code": "REWARDS_NOT_AVAILABLE" }
```

```sh
$ curl 'localhost:8787/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/rewards/summary'
```
```json
{
  "supply_rewards_apr": "0.01753045422122093652885",
  "borrow_rewards_apr": "0",
  "supply_rewards_rate_per_second": "0.000011574074074",
  "borrow_rewards_rate_per_second": "0.001145833333333"
}
```

## `/governance/{network}/all/proposals`
### description:

Aggregate of all governance proposals across Governors alpha and bravo.

Query parameters:
- Pagination: `page_size`, `page_number`
- `proposal_ids[]=123,...` [optional] - filter proposals to only those
  having one of the given ids.

```sh
$ curl 'localhost:8787/governance/mainnet/all/proposals'
```
```json
{
  "proposals": [{
    "eta": 0,
    "title": "Risk Parameter Updates for 3 Compound V2 Assets",
    "proposer": {
      "image_url": "https://profile.compound.finance/1I3iRJq3n4aVeBhYcyL7bhxUpZOHZL-9R/nzKJc1EDRNNO87PtFH0XxQdObjdeQ14LUpiupTgcz2U=",
      "account_url": "http://gauntlet.network",
      "display_name": "Gauntlet",
      "address": "0x683a4f9915d6216f73d6df50151725036bd26c02"
    },
    "end_block": 16555597,
    "start_block": 16535887,
    "description": "## Simple Summary\n\nA proposal to adjust three (3) risk parameters (collateral factor & borrow cap) across three (3) Compound V2 assets. [... elided for example ...]",
    "id": 147,
    "for_votes": "320010.010736308276631616",
    "against_votes": "0.0",
    "actions": [
      {
        "data": "{long hexadecimal abi-encoded calldata string}",
        "value": "0.0",
        "title": "[Comptroller](https://etherscan.io/address/0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b)._setMarketBorrowCaps([\"[cYFI](https://etherscan.io/address/0x80a2ae356fc9ef4305676f7a3e2ed04e12c33946)\"], [30000000000000000000])",
        "target": "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B",
        "signature": "_setMarketBorrowCaps(address[],uint256[])"
      },
      ...
    ],
    "states": [
      {
        "state": "pending",
        "start_time": 1675119155,
        "end_time": 1675277981,
        "transaction_hash": "0x2aa0c68b2f434610189d69fb8e2bdc0ac4cfd7a913f48ed0c6b7ea5d798b572c"
      },
      {
        "state": "active",
        "start_time": 1675277687,
        "end_time": 1675515881
      }
    ]
  }, ...],
  "pagination_summary": {
    "page_size": 100,
    "page_number": 1,
    "total_pages": 2,
    "total_entries": 147
  }
}
```

## `/governance/{network}/all/proposal_vote_receipts`
### description:

Aggregate of proposal vote receipts across Governors alpha and bravo. Must
be filtered by at least one of account (by address) or proposal (by id).

Query parameters:
- Pagination: `page_size`, `page_number`
- One of `account` or `proposal_id` is _required_
- `account` - voter account address for which to retrieve vote receipts
- `proposal_id` - proposal id for which to retrieve vote receipts
- `support` - `true` or `false` - [optional] - [default undefined]
  - `true` filters receipts to votes `For`;
  - `false` filters receipts to votes `Against`;
  - `undefined` returns receipts regardless of vote direction
- `with_proposal_data` - `true` or `false` - [optional] - [default false]
  - `true` populates the `"proposal"` field of the response
  - `false` sets the `"proposal"` field to `null` (this is the default)

Proposal:

```sh
$ curl 'localhost:8787/governance/mainnet/all/proposal_vote_receipts?proposal_id=147`
```
```json
{
  "proposal_vote_receipts": [
    {
      "proposal_id": 147,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/1LFz91R1wl7kkYjjVFQ9uvB2h0jWPqb00/GtDl1nWWOiGk4SNbZ1+eEpNPU+8v6Nz/uVEVPWTMRhc=",
        "account_url": null,
        "display_name": "Robert Leshner",
        "address": "0x88fb3d509fc49b515bfeb04e23f53ba339563981"
      },
      "support": null,
      "votes": "186754.192640718136614743"
    },
    {
      "proposal_id": 147,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/1vxjBH3ddZtM_p_Bi1TpcHvsaYP67nz7M/A+8p1Wj7ZbWuVMYfaR+IIkqZxvHcS9Y4rczaZiU/7eE=",
        "account_url": "https://twitter.com/MonetSupply",
        "display_name": "MonetSupply",
        "address": "0x8d07d225a769b7af3a923481e1fdf49180e6a265"
      },
      "support": true,
      "votes": "70005.238935992282967464"
    },
    ...
  ],
  "pagination_summary": {
    "page_size": 100,
    "page_number": 1,
    "total_pages": 1,
    "total_entries": 23
  }
}
```

Account:

```sh
$ curl 'localhost:8787/governance/mainnet/all/proposal_vote_receipts?account=0x8169522c2c57883e8ef80c498aab7820da539806`
```
```
{
  "proposal_vote_receipts": [
    {
      "proposal_id": 146,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/19mpm2y_kPC8HdbzW50ercV93JE7Tnx_2/j3OputhhpMt8atjfg1M/pvLwYbAnQNqG1kf7bgxq6Ao=",
        "account_url": "https://twitter.com/justHGH",
        "display_name": "Geoffrey Hayes",
        "address": "0x8169522c2c57883e8ef80c498aab7820da539806"
      },
      "support": true,
      "votes": "101000.024654469732833014"
    },
    {
      "proposal_id": 129,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/19mpm2y_kPC8HdbzW50ercV93JE7Tnx_2/j3OputhhpMt8atjfg1M/pvLwYbAnQNqG1kf7bgxq6Ao=",
        "account_url": "https://twitter.com/justHGH",
        "display_name": "Geoffrey Hayes",
        "address": "0x8169522c2c57883e8ef80c498aab7820da539806"
      },
      "support": true,
      "votes": "101000.024654469732833014"
    },
    ...
  ],
  "pagination_summary": {
    "page_size": 100,
    "page_number": 1,
    "total_pages": 1,
    "total_entries": 27
  }
}
```

## `/governance/{network}/comp/accounts`
### description:

Aggregate of COMP-holder account addresses that participate in governance,
ordered by their delegated voting power (not by their actual COMP
balance).

Query parameters:
- Pagination:
  - `page_size` [default 5]
  - `page_number`
  - `addresses` - account addresses to filter down to from all accounts

```sh
$ curl 'localhost:8787/governance/mainnet/comp/accounts'
```
```json
{
  "accounts": [
  {
    "address": "0xea6C3Db2e7FCA00Ea9d7211a03e83f568Fc13BF7",
    "display_name": "Polychain Capital",
    "image_url": "https://static.tally.xyz/7b888910-fdfb-40af-84b1-09847c6054b2_400x400.jpg",
    "account_url": null,
    "balance": "0.11499365783869876",
    "votes": "330977.3351898968",
    "vote_weight": "330977.3351898968",
    "rank": 1,
    "proposals_voted": 39,
    "total_delegates": 160
    },
    {
    "address": "0x61258f12C459984F32b83C86A6Cc10aa339396dE",
    "display_name": "Bain Capital Ventures",
    "image_url": "https://static.tally.xyz/ec86fb34-7b21-4288-966f-37ace859bd9d_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "256766.59314398907",
    "vote_weight": "256766.59314398907",
    "rank": 2,
    "proposals_voted": 4,
    "total_delegates": 60
    },
    {
    "address": "0x9AA835Bc7b8cE13B9B0C9764A52FbF71AC62cCF1",
    "display_name": "a16z",
    "image_url": "https://static.tally.xyz/c8cb82c3-dc7d-4abb-8944-681fb9367df0_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "256018.63638743947",
    "vote_weight": "256018.63638743947",
    "rank": 3,
    "proposals_voted": 36,
    "total_delegates": 306
    },
    {
    "address": "0x8169522c2C57883E8EF80C498aAB7820dA539806",
    "display_name": "Geoffrey Hayes",
    "image_url": "https://static.tally.xyz/b561b1a4-f258-418f-9dab-c80220d7d7ab_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "101000.02465446974",
    "vote_weight": "101000.02465446974",
    "rank": 4,
    "proposals_voted": 17,
    "total_delegates": 17
    },
    {
    "address": "0x8d07D225a769b7Af3A923481E1FdF49180e6A265",
    "display_name": "MonetSupply",
    "image_url": "https://static.tally.xyz/4d829585-3f22-4042-a21c-c14bec45e81a_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "70002.9378630117",
    "vote_weight": "70002.9378630117",
    "rank": 5,
    "proposals_voted": 79,
    "total_delegates": 25
    }
  ]
}
```

## `/governance/{network}/comp/history`
### description:

High level metadata for COMP governance, including the COMP (governance token)
remaining to distributed, the number of votes delegated with COMP, the number
of addresses with votes, and the number of proposals created so far (to be voted on).

NOTE: `comp_remaining` is calculated as the sum of COMP balances across Timelock,
Comptroller and Reservior, which is slightly different from the corresponding field
`total_comp_allocated` in the equivalent V2 endpoint. This is OK as discussed in
https://discord.com/channels/402910780124561410/796451735803002900/1070420107429421076

```sh
$ curl 'localhost:8787/governance/mainnet/comp/history'
```

```json
{
  "votes_delegated": "2649756.603949650754462612",
  "voting_addresses": 4824,
  "proposals_created": 147,
  "comp_remaining": "2481940.263123554206402576",
}
```

## `/governance/{network}/comp/distribution`
### description:

High level data around COMP distribution, including the rate that COMP is
being distributed daily and the remaining COMP left to be distributed.
Also includes COMP distribution data per cToken market.

```sh
$ curl 'localhost:8787/governance/mainnet/comp/distribution'
```
```json
{
  "comp_rate": "0.176",
  "daily_comp": "1267.20",
  "markets": [
    {
      "address": "0xb3319f5d18bc0d84dd1b4825dcde5d5f7266d407",
      "symbol": "cZRX",
      "underlying_address": "0xe41d2489571d322189246dafa5ebde1f4699f498",
      "underlying_name": "0x",
      "underlying_symbol": "ZRX",
      "supplier_daily_comp": "0.00",
      "borrower_daily_comp": "0.00",
    },
    {
      "address": "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643",
      "symbol": "cDAI",
      "underlying_address": "0x6b175474e89094c44da98b954eedeac495271d0f",
      "underlying_name": "DAI",
      "underlying_symbol": "DAI",
      "supplier_daily_comp": "241.20",
      "borrower_daily_comp": "241.20",
    },
    ...
  ]
}
```

## `/legacy/mainnet/ctokens`
### description:

Retreive Compound V2 CTokens data

```sh
$ curl 'localhost:8787/legacy/mainnet/ctokens'
```
```json
{
   "cToken":[
      {
         "name":"Compound 0x",
         "underlying_name":"0x",
         "symbol":"cZRX",
         "underlying_symbol":"ZRX",
         "token_address":"0xb3319f5d18bc0d84dd1b4825dcde5d5f7266d407",
         "underlying_address":"0xe41d2489571d322189246dafa5ebde1f4699f498",
         "borrow_rate":"0.04409829738476745",
         "supply_rate":"0.0019605539072082845",
         "borrow_cap":"1000000.0",
         "collateral_factor":"0.65",
         "comp_borrow_apy":"0",
         "comp_supply_apy":"0",
         "exchange_rate":"0.0206015410768160280046446513",
         "reserve_factor":"0.25",
         "reserves":"1788100.867423172906350829",
         "total_borrows":"464884.6338852752485902",
         "total_supply":"372902485.32525833",
         "underlying_price":"0.249232",
         "total_supply_value":"1914691.41028132422080528337928",
         "total_borrow_value":"115864.1270724949207566327264"
      },
      ...
   ]
}
```

## `/legacy/mainnet/gas-price`
### description:

Retreive gas prices for Ethereum mainnet.

```sh
$ curl 'localhost:8787/legacy/mainnet/gas-price'
```
```json
{
   "fastest":{
      "value":"23000000000"
   },
   "fast":{
      "value":"23000000000"
   },
   "average":{
      "value":"23000000000"
   },
   "safe_low":{
      "value":"23000000000"
   }
}
```

## `/account/{account_address}/transaction_history`
### description:

Retrieves comet transaction history for a given account address.

Query parameters:
- `limit` (optional): number of max items to retrieve. Default and max is 15.
- `markets[]` (optional): array of markets filter to be included in the response. Default is all non-testnet markets. (e.g. filter only Ethereum cUSDCv3 market `markets[]=1_0xc3d688B66703497DAA19211EEdff47f25384cdc3`)
- `actions[]` (optional): array of actions to filter transactions by. Default is all actions. (e.g. filter only borrow actions `actions[]=Borrow`)
- `cursor` (optional): The first response (with no cursor parameter) will return with a cursor value, to pass that cursor value will allow request to get more transaction history further in the past.

A cursor belongs to the registry version it was issued against. If that
version is no longer the active one, the request answers `409` and the client
restarts pagination without a cursor:

```json
{
  "error": {
    "code": "REGISTRY_VERSION_CHANGED",
    "message": "the market registry changed; restart pagination without a cursor",
    "cursorRegistryVersionId": "8f1e0f3c-...",
    "registryVersionId": "b2c4d6e8-..."
  }
}
```

```sh
$ curl 'localhost:8787/account/0xcfc50541c3dEaf725ce738EF87Ace2Ad778Ba0C5/transaction_history?limit=30&actions[]=Borrow&markets[]=1_0xc3d688B66703497DAA19211EEdff47f25384cdc3'
```
```json
{
  "done": true,
  "cursor": "6e6069b3ebd443fef9538aa8f22ffc087e5429264f8dce214c7bda1efc5817cc",
  "item_count": 12,
  "item_limit": 15,
  "items": [
    {
      "transaction_hash": "0x0b10edd47ea1611a701579f0c4541da188c0c341b08808079d5f730c68e27234",
      "timestamp": 1678499891,
      "network": {
        "chain_id": 1,
        "alias": "mainnet"
      },
      "initiated_by": {
        "image_url": null,
        "account_url": null,
        "display_name": null,
        "address": "0xcfc50541c3deaf725ce738ef87ace2ad778ba0c5"
      },
      "item_type": "Bulk",
      "actions": [
        {
          "action_type": "Borrow",
          "event_type": "Withdraw",
          "contract": {
            "address": "0xc3d688b66703497daa19211eedff47f25384cdc3"
          },
          "token": {
            "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "symbol": "USDC"
          },
          "amount": "500000.0"
        }
      ]
    },
    {
      "transaction_hash": "0x26c71588d841fb9826b4ffe0326b899bcf592453b7082d05094bd059f0e72595",
      "timestamp": 1678491743,
      "network": {
        "chain_id": 1,
        "alias": "mainnet"
      },
      "initiated_by": {
        "image_url": null,
        "account_url": null,
        "display_name": null,
        "address": "0xcfc50541c3deaf725ce738ef87ace2ad778ba0c5"
      },
      "item_type": "Unit",
      "actions": [
        {
          "action_type": "Borrow",
          "event_type": "Withdraw",
          "contract": {
            "address": "0xc3d688b66703497daa19211eedff47f25384cdc3"
          },
          "token": {
            "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "symbol": "USDC"
          },
          "amount": "1440000.0"
        }
      ]
    }
    ...
  ]
}
```

# Registry v1

Everything under `/registry/v1` is answered by the registry, including its
errors, which use one envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "...", "requestId": "..." } }
```

Public reads are cacheable and carry `ETag`, `X-Registry-Version` and
`X-Registry-Checksum`; they answer `503 REGISTRY_NOT_ACTIVE` when no version
is active. Administrative routes require `Authorization: Bearer <token>`, are
rate limited per actor, and answer no CORS headers at all.

## `/registry/v1/active`
### description:

The whole activated snapshot: networks, their markets, and the presentation
and price-exception data an application needs to render them. This is the
bootstrap read; everything below serves parts of the same version.

```sh
$ curl 'localhost:8787/registry/v1/active'
```

## `/registry/v1/networks`
### description:

The networks of the active version, without their markets.

## `/registry/v1/networks/{chain_id}/markets`
### description:

The markets of one chain, in the same order the snapshot lists them.

## `/registry/v1/networks/{chain_id}/markets/{comet_address}`
### description:

One market, addressed by its Comet. A `disabled` market answers `404`; a
`deprecated` one is served, because positions and history in it must stay
reachable.

## `/registry/v1/versions/{version_id}`
### description:

A validated version by id, so a session that pinned one can refetch exactly
what it pinned even after another version was activated.

## `POST /registry/v1/admin/sync`
### description:

Starts or continues an import. `sourceCommitSha` pins an explicit commit,
`forceNewAttempt` rebuilds an attempt, and `holdForReview` leaves the
candidate open once every root is imported, so a market the source added can
be reviewed before the version validates; each of the three is a decision
rather than routine scheduling, and requires a `reason`. The first import of
an environment is held regardless. `markets` bounds how many markets this
request imports, from 1 to 50, and defaults to 50. Answers `202` with the
run, the version it is importing into, and `heldForReview`.

A held candidate is validated too, so its diagnostics can be read, but keeps
its `importing` status: `checksFailed` says how many of its checks failed, and
is `0` for one that would validate as it stands. A candidate another
invocation is importing into is not one held for review, and asking for a sync
while that run holds its lease answers `409 SYNC_ALREADY_RUNNING`.

When the import fails, the answer says whether trying again can help. A
request the registry refuses answers with the status its code maps to — a
`sourceCommitSha` the tracked ref cannot reach is `422` — and a candidate that
failed its checks is `422` with `syncRunId` and `registryVersionId` in
`details`, to read its validation by. Only a source that did not answer is
`503`.

## `GET /registry/v1/admin/sync-runs/{sync_run_id}`
### description:

One import run and its per-root checkpoints, including why a root failed and
when the run becomes resumable.

## `GET /registry/v1/admin/versions/{version_id}`
### description:

A version with its validation summary and activation history.

## `POST /registry/v1/admin/versions/{version_id}/validate`
### description:

Re-runs validation over a candidate and records the result. Answers `422`
when the candidate is invalid, with the checks that decided it, and `409`
while its import is still running.

It takes no body. Validation decides nothing: it checks the stored candidate
and records every check it ran, exactly as the scheduled import does
unattended. The decision a person makes about a version, with its reason, is
the activation.

## `POST /registry/v1/admin/versions/{version_id}/activate`
### description:

Makes a validated version the one the API serves. Requires a `reason`, which
is stored with the audit event. Activating the version that is already active
changes nothing.

## `POST /registry/v1/admin/versions/{version_id}/rollback`
### description:

The same move in the other direction, recorded as a rollback.

## `PUT /registry/v1/admin/versions/{version_id}/networks/{chain_id}/overlay`
### description:

Replaces the reviewed overlay of one network: display names, asset display
overrides, unwrapped collateral assets, and price exceptions. An overlay is a
complete document; a missing key is a missing decision, not a default.

The overlay is applied to the rows the import wrote, and a network reviewed
this way stops being listed as unreviewed. A chain the candidate has not
imported yet answers `404`: the import writes every network it reaches, so
the answer is to let it continue.

## `PUT /registry/v1/admin/versions/{version_id}/markets/{chain_id}/{deployment_key}/overlay`
### description:

The same for one market: its display name, status, capabilities, quote unit,
USD feed, and reward feed. A market the import wrote without a review is
disabled until this is applied to it, and
`GET /registry/v1/admin/versions/{version_id}` lists what is still
unreviewed.

It also states how the frontend lists the market. `displayName` is its label,
`slug` — lowercase letters, digits, dots and hyphens, or `null` — is what the
frontend addresses it by where the label is shared with another market of
the same network, and `isInstitutional` lists it in the institutional section.
Within a network, no two markets that are not disabled may answer to the same
`slug`, or to the same label where they have none; validation refuses a
version where they do, and a slug another market of the network keeps is
refused with `409`.

## `GET /registry/v1/admin/versions/{version_id}/markets/{chain_id}/{deployment_key}/overlay`
### description:

The overlay a market of the version carries, in the form the `PUT` above
takes: read it, change what is different, and send it back with a reason. The
overlay of a similar market is where describing a new one starts. A market
nobody has reviewed answers with the provisional decisions its import wrote,
and `reviewed: false`.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "scope": "8453/usdc",
  "reviewed": true,
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

## `PUT /registry/v1/admin/versions/{version_id}/overlays`
### description:

Many overlays in one request: the way a new environment is reviewed, where
every network and market the first import wrote needs its decisions at once.
`GET /versions/{version_id}/proposal` answers with exactly this body under
`bundle`.

Network overlays are keyed by chain id and market overlays by
`chainId/deploymentKey`; each is the same complete document the one-scope
routes take, decided the same way, and `reason` is stored with every audit
event the request records. Up to 100 overlays, in a body of up to 512 KiB.

The request is applied all at once or not at all. Every document is parsed
and every network and market it names is found before anything is written,
and the writes are one D1 transaction: a document the parser refuses answers
`400` naming it, and scopes the candidate has not imported answer `404`
naming all of them, with nothing written in either case. A request may move
the default market or a slug between the markets it names, or swap two slugs,
in whatever order it names them. Only an importing candidate is
writable (`409` otherwise).

```json
{
  "reason": "bootstrap: derived from the static constants against Compound-Foundation/comet@a34d9b571c83",
  "networks": { "1": { "displayName": "Ethereum", "assetDisplayOverrides": [], "unwrappedCollateralAssets": [], "priceExceptions": [] } },
  "markets":  { "1/usdc": { "displayName": "USDC", "contractName": "cUSDCv3", "...": "..." } }
}
```

The answer says what each document changed, in the order the request named
them, and what the candidate still has unreviewed. A document identical to
what is stored changes nothing and records no event, so sending the same
directory again is safe.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "changed": true,
  "snapshotChecksum": null,
  "documents": [
    { "scopeType": "network", "scopeKey": "1",      "changed": true,  "overlayEventId": "0d0f3f7e-..." },
    { "scopeType": "market",  "scopeKey": "1/usdc", "changed": true,  "overlayEventId": "5b1c2a90-..." },
    { "scopeType": "market",  "scopeKey": "1/weth", "changed": false, "overlayEventId": null }
  ],
  "unreviewed": { "networks": [], "markets": [] }
}
```

## `GET /registry/v1/admin/versions/{version_id}/proposal`
### `GET /registry/v1/admin/versions/{version_id}/proposal/review`
### description:

What the release serving the request proposes as the first review of a
version: for every market the version imported that the static constants
describe, the decisions the API already acts on, and for every network, its
name, presentation and price exceptions. A market the constants do not
describe is not proposed; it is listed under `needsDecision`, and stays
switched off until it is described with the market overlay route.

`/proposal` answers with the proposal as data: its `digest`, what it leaves
undecided, and under `bundle` the body `PUT /versions/{version_id}/overlays`
takes. `/proposal/review` answers with the same proposal as a document to read
(`text/markdown`), naming the digest to apply it by. Neither changes anything.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "digest": "3f9a1c0e7b2d4a61",
  "needsDecision": [],
  "bundle": { "reason": "bootstrap: derived from the static constants against Compound-Foundation/comet@a34d9b571c83", "networks": { "...": "..." }, "markets": { "...": "..." } }
}
```

## `POST /registry/v1/admin/versions/{version_id}/proposal/apply`
### description:

Applies the proposal by its digest: `{"reason": "...", "digest": "<16 hex>"}`.
The proposal is built again and written only if it still has that digest, so
what is applied is exactly what was read; one that changed since — another
release, another version — answers `409` with its current digest in
`details`. The write is the one `PUT /versions/{version_id}/overlays` makes,
all of it or none, and answers the same way, with the `digest` beside it.
Only an importing version is writable.

## `GET /registry/v1/admin/shadow`
### `GET /registry/v1/admin/versions/{version_id}/shadow`
### description:

What the active version — or a validated candidate, before activating it —
says against what the static constants in the Worker still say. `agrees` is
the one flag a check can read; `differences` names every field the two answer
differently, and `onlyInStatic` / `onlyInRegistry` the markets only one of
them describes.

```json
{
  "agrees": false,
  "shadow": {
    "versionId": "8f1e0f3c-3b7a-4e8f-9a1b-1f0f0b9a2c44",
    "checksum": "1bd74ebe...",
    "staticMarkets": 29,
    "registryMarkets": 29,
    "onlyInStatic": [],
    "onlyInRegistry": [],
    "differences": [
      {
        "scope": "1/wbtc",
        "field": "baseAsset.priceFeed",
        "static": "0xf4030086522a5beea4988f8ca5b36dbc97bee88c",
        "registry": "0xfdfd9c85ad200c506cf9e21f1fd8dd01932fbb23"
      }
    ]
  }
}
```

## `GET /registry/v1/admin/versions/{version_id}/changes`
### description:

What a version changes against the version that is on: the networks and
markets it adds or drops, and every fact and decision of the others that
differs. It is what to read before switching a newer version on, where the
shadow comparison only measures against the static constants.

It answers for a candidate that is still importing as well, because that is
when a market the source has added is described: such a market is listed
under `markets.added` whole, with everything its import read from the source
and the chain, and `reviewed: false` until someone describes it. With no
version on, `comparedWith` is `null` and everything is added.

A change is one field on a flattened path, with both answers. Lists are
compared by position with their length beside them, so a collateral the
source adds reads as a longer list and one more entry.

```json
{
  "versionId": "0b7c2e7a-1d5e-4f39-8c55-6f7b1c4f2a10",
  "status": "importing",
  "comparedWith": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "networks": { "added": [], "removed": [], "changed": [] },
  "markets": {
    "added": [
      { "scope": "8453/usdt", "reviewed": false, "market": { "deploymentKey": "usdt", "status": "disabled", "...": "..." } }
    ],
    "removed": [],
    "changed": [
      {
        "scope": "42161/usdc",
        "field": "baseAsset.priceFeed.address",
        "before": "0x50834f3163758fcc1df9973b6e91f0f0f0434ad3",
        "after": "0x880d36763bb470cd395b7d6c76b50446fa70ace5"
      }
    ]
  }
}
```
