import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';

interface Artifact {
  abi: utils.Fragment[];
}

interface AbiShape {
  selectors: string[];
  eventTopics: string[];
}

let failed = false;

function readArtifact(artifactPath: string): Artifact {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`NOT_FOUND at ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
}

function getAbiShape(artifactPath: string): AbiShape {
  const artifact = readArtifact(artifactPath);
  const iface = new utils.Interface(artifact.abi);
  return {
    selectors: Object.keys(iface.functions)
      .map((signature) => iface.getSighash(signature))
      .sort(),
    eventTopics: Object.keys(iface.events)
      .map((signature) => iface.getEventTopic(signature))
      .sort(),
  };
}

function artifactPath(root: string, relativePath: string, name: string): string {
  return path.join(root, 'artifacts', relativePath, `${name}.json`);
}

function compareExact(left: AbiShape, right: AbiShape, label: string, field: keyof AbiShape): void {
  const equal = JSON.stringify(left[field]) === JSON.stringify(right[field]);
  console.log(`  ${field} equal: ${equal}`);
  if (equal) return;

  const rightSet = new Set(right[field]);
  const leftSet = new Set(left[field]);
  console.log(
    `  only in local ${label}:`,
    left[field].filter((value) => !rightSet.has(value))
  );
  console.log(
    `  only in upstream ${label}:`,
    right[field].filter((value) => !leftSet.has(value))
  );
  failed = true;
}

// Pool intentionally adds the reserve-factor accrual surface (audit #27 / AF-003):
// syncIndexesState / syncRatesState. Both are admin-only (onlyPoolConfigurator) and add no
// storage; they bracket setReserveFactor so the elapsed interval is settled at the old factor.
// The gate pins exactly these two additions over the v3.0.x (@aave/core-v3) baseline.
function comparePoolSelectors(local: AbiShape, upstream: AbiShape): void {
  const expectedSelectors = [
    ...upstream.selectors,
    utils.id('syncIndexesState(address)').slice(0, 10),
    utils.id('syncRatesState(address)').slice(0, 10),
  ].sort();

  const equal = JSON.stringify(local.selectors) === JSON.stringify(expectedSelectors);
  console.log(`  selectors equal plus accrual extension: ${equal}`);
  if (equal) return;

  const expectedSet = new Set(expectedSelectors);
  const localSet = new Set(local.selectors);
  console.log(
    '  unexpected local Pool selectors:',
    local.selectors.filter((value) => !expectedSet.has(value))
  );
  console.log(
    '  missing expected Pool selectors:',
    expectedSelectors.filter((value) => !localSet.has(value))
  );
  failed = true;
}

function compareTokenEvents(local: AbiShape, upstream: AbiShape): void {
  const upstreamTopics = new Set(upstream.eventTopics);
  const localTopics = new Set(local.eventTopics);
  const missing = upstream.eventTopics.filter((topic) => !localTopics.has(topic));
  const added = local.eventTopics.filter((topic) => !upstreamTopics.has(topic));
  const priceObservedTopic = utils.id(
    'PriceObserved(address,uint256,uint256,address,uint8,bool,address,uint256)'
  );

  console.log(`  upstream topics preserved: ${missing.length === 0}`);
  console.log(`  added event topics:`, added);

  if (missing.length !== 0 || added.length !== 1 || added[0] !== priceObservedTopic) {
    failed = true;
  }
}

const upstreamRoot = path.dirname(require.resolve('@aave/core-v3/package.json'));
const localRoot = process.cwd();

console.log('ABI Selector And Event Surface Check\n');

for (const [relativePath, name] of [
  ['contracts/protocol/pool/Pool.sol', 'Pool'],
  ['contracts/protocol/tokenization/AToken.sol', 'AToken'],
  ['contracts/protocol/tokenization/VariableDebtToken.sol', 'VariableDebtToken'],
]) {
  console.log(`${name}:`);

  try {
    const local = getAbiShape(artifactPath(localRoot, relativePath, name));
    const upstream = getAbiShape(artifactPath(upstreamRoot, relativePath, name));

    console.log(`  local selectors: ${local.selectors.length}`);
    console.log(`  upstream selectors: ${upstream.selectors.length}`);
    if (name === 'Pool') {
      comparePoolSelectors(local, upstream);
    } else {
      compareExact(local, upstream, name, 'selectors');
    }

    console.log(`  local event topics: ${local.eventTopics.length}`);
    console.log(`  upstream event topics: ${upstream.eventTopics.length}`);
    if (name === 'Pool') {
      compareExact(local, upstream, name, 'eventTopics');
    } else {
      compareTokenEvents(local, upstream);
    }
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}

if (failed) process.exit(1);
