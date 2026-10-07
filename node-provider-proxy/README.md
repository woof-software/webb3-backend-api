# Infura Worker

CloudFlare worker to proxy JSON-RPC requests needed for the v3 App.

## Important Notes
- A batch of JSON-RPC calls goes to the provider in pieces of at most 100 calls, and a batch of one call as that call alone. When the provider fails some pieces and answers the others, and `retryIndividualFailedRpcs` or `retryWithActiveFallback` is on, the answers are kept and only the calls of the failed pieces are asked of the next provider. With both settings off, on a network with no other provider, or when the next provider fails those calls too, the batch is answered `503` with `Retry-After`, as a request that fails whole is.
- When inspecting an RPC request, we currently only filter on the first element, if `params` is an array.

## Getting Started

First, install dependencies with Node.js 22 or newer:

```sh
npm install
```

## Configuration

The node provider proxy requires several items to be configured in order to function properly. The items are configured in (`wrangler.toml`) and are used when running the proxy locally. It is recommended to configure all of the items as Cloudflare secretes in your Cloudflare worker deployment after you have deployed your proxy as a worker to Cloudflare..

Each of the secrets vars have the following descriptions:

- `allowedAppKey` - Optional application key for the proxy to check for on all proxied requests. The proxy has the url format of `http://hostname/{network}/{optional_appkey}`. 
- `allowedHosts` - Optional hostnames array to check for on all proxied requests. Can be used to aid in checking the origination of a proxy request comes from a known source.
- `alchemyXXXMainnet` - Alchemy RPC Key - The proxy relies on Alchemy as the sole provider for rpc traffic.
- `infuraKey` - Infura RPC Key (configurable) - The proxy can be configured to use quicknode for rpc traffic.
- `quicknodeXXXMainnet` - Quicknode RPC Keys (configurable) - The proxy can be configured to use quicknode for rpc traffic.
- `quicknodeXXXMainnetSubdomain` - Quicknode RPC Subdomian (configurable) - Used in conjuction with a Quicknode RPC keys.

Every provider secret named in `src/providers.ts` must be set. Without one, every request is answered `500 unexpected error`, and the worker's log names the missing secret.


## Running Locally

To start a local server for the Web3 Worker, run:

```
npm start
```

A local run of c3-api reads the chain through this one, bound by the name of
its default environment, `node-provider-proxy-local` (c3-api's README,
Getting Started). Beside it, start the proxy on a port of its own, since
c3-api takes 8787:

```
npm start -- --port 8788
```

## Testing

To test the Web3 Worker, run:

```sh
npm test
```

The tests run on the compiled output, so build first; `npm run build` builds and then runs them. CI builds and tests the proxy on every push that changes it, the shared libraries under `c3-api/lib`, the fetch mock its tests use, or what those compile with: `c3-api/tsconfig.json` and the shim under `c3-api/shim`.
