import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';
import {
  createCandidate,
  writeCandidateSnapshot,
} from '../../src/registry/repository.js';

/*
 * Loads the frozen RegistrySnapshotV1 fixture and seeds it into D1 as an
 * importing candidate. Writing goes through the candidate repository, so
 * tests exercise the same mapping the importer uses rather than a second copy
 * of it. tests/lib/registry/registry-snapshot-v1-fixture.test.ts is what
 * enforces the contract of the file itself.
 */
const FIXTURE_PATH = './tests/fixtures/registry/registry-snapshot-v1.json';

function loadRegistrySnapshotFixture(): RegistrySnapshotV1 {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type SeedOptions = {
  // defaults to the fixture's own version id
  versionId?: string,
  attempt?:   number,
};

type SeededCandidate = {
  versionId:        string,
  snapshotChecksum: string,
  // row counts by table, so a test can assert what reached the database
  counts:           Record<string, number>,
};

async function seedCandidate(
  db: D1Database,
  snapshot: RegistrySnapshotV1,
  options: SeedOptions = {},
): Promise<SeededCandidate> {
  const versionId = options.versionId ?? snapshot.registryVersion.id;
  const version = await createCandidate(db, {
    versionId,
    repository:     snapshot.registryVersion.sourceRepository,
    commitSha:      snapshot.registryVersion.sourceCommitSha,
    sourceChecksum: sha256Hex(`source:${versionId}`),
    attempt:        options.attempt ?? 1,
    createdBy:      'test-seed',
  });

  /*
   * A market row id is a primary key across versions, so seeding the same
   * fixture a second time needs fresh ids. The fixture's own version keeps
   * the ids it was frozen with, which is what lets a test address a market
   * by the id the fixture states.
   */
  const networks = versionId === snapshot.registryVersion.id
    ? snapshot.networks
    : snapshot.networks.map(network => ({
        ...network,
        markets: network.markets.map(market => ({ ...market, id: randomUUID() })),
      }));

  const counts = await writeCandidateSnapshot(db, version.id, networks);
  return {
    versionId:        version.id,
    snapshotChecksum: snapshot.registryVersion.checksum,
    counts: {
      registry_networks:        counts.networks,
      network_price_exceptions: counts.priceExceptions,
      markets:                  counts.markets,
      tokens:                   counts.tokens,
      market_contracts:         counts.contracts,
      market_assets:            counts.assets,
    },
  };
}

export type { SeedOptions, SeededCandidate };

export {
  loadRegistrySnapshotFixture,
  seedCandidate,
  sha256Hex,
};
