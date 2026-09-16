# Webb3 Backend Api

Workspace that contains both projects used to power the backend api for the
Webb3 frontend application. Please see each project for additional readme instructions.

## Requirements

- Node.js 22 or newer. Wrangler 4 requires it, and both workers declare it in `engines.node`.

## Lockfiles

| Lockfile | Covers | Consumed by |
|---|---|---|
| `package-lock.json` | shared workspace libraries under `c3-api/lib` and `c3-api/tests/util/mock` | the `preinstall` script of both workers (`npm install-clean --workspaces`) and the root `npm audit` step in CI |
| `c3-api/package-lock.json` | the c3-api worker, including Wrangler and the test runner | `npm install`, `npm test`, the `deploy:*` scripts, and the c3-api `npm audit` step in CI |
| `node-provider-proxy/package-lock.json` | the node-provider-proxy worker | `npm install`, `npm run build`, the `deploy:*` scripts, and the proxy `npm audit` step in CI |

Deployments run through each worker's `deploy:*` scripts. CI runs the dependency audits on Node.js 22.
