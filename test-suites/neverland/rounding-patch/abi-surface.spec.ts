import { expect } from 'chai';
import { Interface } from 'ethers/lib/utils';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const upstreamRoot = dirname(require.resolve('@aave/core-v3/package.json'));

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const repoFile = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');
const upstreamFile = (relativePath: string) =>
  readFileSync(join(upstreamRoot, relativePath), 'utf8');

const localArtifact = (relativePath: string, name: string) =>
  readJson(join(process.cwd(), 'artifacts', relativePath, `${name}.json`));

const localBuildOutput = (relativePath: string, name: string) => {
  const artifactDir = join(process.cwd(), 'artifacts', relativePath);
  const debug = readJson(join(artifactDir, `${name}.dbg.json`));
  const buildInfo = readJson(join(artifactDir, debug.buildInfo));
  return buildInfo.output.contracts[relativePath][name];
};

const upstreamArtifact = (relativePath: string, name: string) =>
  readJson(join(upstreamRoot, 'artifacts', relativePath, `${name}.json`));

const upstreamBuildOutput = (relativePath: string, name: string) => {
  const artifactDir = join(upstreamRoot, 'artifacts', relativePath);
  const debug = readJson(join(artifactDir, `${name}.dbg.json`));
  const buildInfo = readJson(join(artifactDir, debug.buildInfo));
  return buildInfo.output.contracts[relativePath][name];
};

const selectorsOf = (abi: any[]) => {
  const iface = new Interface(abi);
  return Object.keys(iface.functions)
    .map((signature) => iface.getSighash(signature))
    .sort();
};

const eventTopicsOf = (abi: any[]) => {
  const iface = new Interface(abi);
  return Object.keys(iface.events)
    .map((signature) => iface.getEventTopic(signature))
    .sort();
};

const normalizeType = (type: string) =>
  type
    .replace(/\)\d+/g, ')')
    .replace(/t_struct\(([^)]+)\)\d+_storage/g, 't_struct($1)_storage')
    .replace(/t_enum\(([^)]+)\)\d+/g, 't_enum($1)');

const normalizeStorageLayout = (layout: any) => ({
  storage: layout.storage.map(({ label, slot, offset, type }: any) => ({
    label,
    slot,
    offset,
    type: normalizeType(type),
  })),
  types: Object.fromEntries(
    Object.entries(layout.types ?? {})
      .map(([key, value]: [string, any]): [string, any] => [
        normalizeType(key),
        {
          encoding: value.encoding,
          label: value.label,
          numberOfBytes: value.numberOfBytes,
          members: (value.members ?? []).map(({ label, slot, offset, type }: any) => ({
            label,
            slot,
            offset,
            type: normalizeType(type),
          })),
        },
      ])
      .sort(([left], [right]) => left.localeCompare(right))
  ),
});

describe('Neverland rounding patch ABI surface', () => {
  it('pins direct-port revision bumps needed by VersionedInitializable', () => {
    expect(repoFile('contracts/protocol/pool/Pool.sol')).to.match(
      /uint256\s+public\s+constant\s+POOL_REVISION\s*=\s*0x2\s*;/
    );
    expect(repoFile('contracts/protocol/tokenization/AToken.sol')).to.match(
      /uint256\s+public\s+constant\s+ATOKEN_REVISION\s*=\s*0x3\s*;/
    );
    expect(repoFile('contracts/protocol/tokenization/VariableDebtToken.sol')).to.match(
      /uint256\s+public\s+constant\s+DEBT_TOKEN_REVISION\s*=\s*0x2\s*;/
    );

    expect(upstreamFile('contracts/protocol/tokenization/AToken.sol')).to.match(
      /uint256\s+public\s+constant\s+ATOKEN_REVISION\s*=\s*0x1\s*;/
    );
    expect(upstreamFile('contracts/protocol/tokenization/VariableDebtToken.sol')).to.match(
      /uint256\s+public\s+constant\s+DEBT_TOKEN_REVISION\s*=\s*0x1\s*;/
    );
  });

  it('keeps canonical token and Pool function selectors aligned with the baseline package', () => {
    for (const [relativePath, name] of [
      ['contracts/protocol/tokenization/AToken.sol', 'AToken'],
      ['contracts/protocol/tokenization/VariableDebtToken.sol', 'VariableDebtToken'],
      ['contracts/protocol/pool/Pool.sol', 'Pool'],
    ]) {
      expect(selectorsOf(localArtifact(relativePath, name).abi)).to.deep.eq(
        selectorsOf(upstreamArtifact(relativePath, name).abi),
        `${name} selectors changed`
      );
    }
  });

  it('preserves baseline event topics and only extends token events with PriceObserved', () => {
    for (const [relativePath, name] of [
      ['contracts/protocol/tokenization/AToken.sol', 'AToken'],
      ['contracts/protocol/tokenization/VariableDebtToken.sol', 'VariableDebtToken'],
    ]) {
      const upstreamTopics = eventTopicsOf(upstreamArtifact(relativePath, name).abi);
      const localTopics = eventTopicsOf(localArtifact(relativePath, name).abi);

      for (const topic of upstreamTopics) {
        expect(localTopics).to.include(topic, `${name} missing upstream event topic ${topic}`);
      }

      expect(localTopics.length).to.eq(upstreamTopics.length + 1, `${name} unexpected event delta`);
    }

    expect(eventTopicsOf(localArtifact('contracts/protocol/pool/Pool.sol', 'Pool').abi)).to.deep.eq(
      eventTopicsOf(upstreamArtifact('contracts/protocol/pool/Pool.sol', 'Pool').abi)
    );
  });

  it('keeps PriceEmitter storage-free', () => {
    const storage = localBuildOutput(
      'contracts/protocol/tokenization/base/PriceEmitter.sol',
      'PriceEmitter'
    ).storageLayout.storage;

    expect(storage).to.deep.eq([]);
  });

  it('keeps canonical Pool and token storage layouts upgrade-compatible with the baseline package', () => {
    for (const [relativePath, name] of [
      ['contracts/protocol/tokenization/AToken.sol', 'AToken'],
      ['contracts/protocol/tokenization/VariableDebtToken.sol', 'VariableDebtToken'],
      ['contracts/protocol/pool/Pool.sol', 'Pool'],
    ]) {
      expect(
        normalizeStorageLayout(localBuildOutput(relativePath, name).storageLayout),
        `${name} storage layout drifted`
      ).to.deep.eq(normalizeStorageLayout(upstreamBuildOutput(relativePath, name).storageLayout));
    }
  });

  it('links the canonical Pool without BridgeLogic', () => {
    const linkReferences = localArtifact('contracts/protocol/pool/Pool.sol', 'Pool').linkReferences;
    const linkedLibraries = Object.values(linkReferences).flatMap((contracts: any) =>
      Object.keys(contracts)
    );

    expect(linkedLibraries.sort()).to.deep.eq([
      'BorrowLogic',
      'EModeLogic',
      'FlashLoanLogic',
      'LiquidationLogic',
      'PoolLogic',
      'SupplyLogic',
    ]);
    expect(linkedLibraries).to.not.include('BridgeLogic');
  });
});
