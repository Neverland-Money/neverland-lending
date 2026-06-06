import hre from 'hardhat';
import { BigNumber, Contract, utils } from 'ethers';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const LIQUIDATION_THRESHOLD_START_BIT_POSITION = 16;
const LIQUIDATION_BONUS_START_BIT_POSITION = 32;
const STABLE_BORROWING_ENABLED_START_BIT_POSITION = 59;
const DEFAULT_LOG_STEP = 100_000;
const UINT16_MASK = BigNumber.from(2).pow(16).sub(1);
const PERCENTAGE_FACTOR = BigNumber.from(10_000);

interface ReserveCheck {
  asset: string;
  symbol: string;
  liquidationThreshold: BigNumber;
  liquidationBonus: BigNumber;
  stableBorrowingEnabled: boolean;
  stableDebtSupply: BigNumber;
  unbacked: BigNumber;
}

function getEnvAddress(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && utils.isAddress(value)) return utils.getAddress(value);
  }
  return undefined;
}

function getEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function isFlagSet(configurationData: BigNumber, bit: number): boolean {
  return configurationData.shr(bit).and(1).eq(1);
}

function readUint16(configurationData: BigNumber, startBit: number): BigNumber {
  return configurationData.shr(startBit).and(UINT16_MASK);
}

function readStructField<T>(value: any, key: string, index: number): T {
  return (value[key] ?? value[index]) as T;
}

function topicToAddress(topic: string): string {
  return utils.getAddress(`0x${topic.slice(26)}`);
}

async function resolveAddressesProvider(): Promise<Contract> {
  const explicit = getEnvAddress([
    'POOL_ADDRESSES_PROVIDER',
    'ROUNDING_PATCH_POOL_ADDRESSES_PROVIDER',
  ]);
  if (explicit) {
    return hre.ethers.getContractAt('IPoolAddressesProvider', explicit);
  }

  const deployments = (hre as any).deployments;
  if (deployments?.getOrNull) {
    const deployment = await deployments.getOrNull('PoolAddressesProvider');
    if (deployment?.address) {
      return hre.ethers.getContractAt('IPoolAddressesProvider', deployment.address);
    }
  }
  if (deployments?.get) {
    try {
      const deployment = await deployments.get('PoolAddressesProvider');
      if (deployment?.address) {
        return hre.ethers.getContractAt('IPoolAddressesProvider', deployment.address);
      }
    } catch {
      // Fall through to the explicit-address error below.
    }
  }

  throw new Error(
    'Set POOL_ADDRESSES_PROVIDER or ROUNDING_PATCH_POOL_ADDRESSES_PROVIDER for live-state checks'
  );
}

async function scanBridgeRole(
  aclManager: Contract,
  targetBlock: number
): Promise<{ bridgeRole: string; grants: string[]; activeMembers: string[] }> {
  const provider = hre.ethers.provider;
  const bridgeRole = await aclManager.BRIDGE_ROLE({ blockTag: targetBlock });
  const roleGrantedTopic = utils.id('RoleGranted(bytes32,address,address)');
  const roleRevokedTopic = utils.id('RoleRevoked(bytes32,address,address)');
  const fromBlock = getEnvNumber('ROUNDING_PATCH_ACL_FROM_BLOCK', 0);
  const step = getEnvNumber('ROUNDING_PATCH_LOG_STEP', DEFAULT_LOG_STEP);
  const members = new Set<string>();
  const grants = new Set<string>();

  for (let start = fromBlock; start <= targetBlock; start += step + 1) {
    const end = Math.min(start + step, targetBlock);
    const logs = await provider.getLogs({
      address: aclManager.address,
      fromBlock: start,
      toBlock: end,
      topics: [[roleGrantedTopic, roleRevokedTopic], bridgeRole],
    });

    for (const log of logs) {
      const account = topicToAddress(log.topics[2]);
      if (log.topics[0] === roleGrantedTopic) {
        grants.add(account);
        members.add(account);
      } else {
        members.delete(account);
      }
    }
  }

  return {
    bridgeRole,
    grants: [...grants].sort(),
    activeMembers: [...members].sort(),
  };
}

async function main() {
  const provider = hre.ethers.provider;
  const targetBlock = getEnvNumber('ROUNDING_PATCH_BLOCK', await provider.getBlockNumber());
  const addressesProvider = await resolveAddressesProvider();
  const poolAddress = await addressesProvider.getPool({ blockTag: targetBlock });
  const aclManagerAddress = await addressesProvider.getACLManager({ blockTag: targetBlock });
  const sentinelAddress = await addressesProvider.getPriceOracleSentinel({
    blockTag: targetBlock,
  });

  const pool = await hre.ethers.getContractAt('IPool', poolAddress);
  const aclManager = await hre.ethers.getContractAt('IACLManager', aclManagerAddress);
  const reserves: string[] = await pool.getReservesList({ blockTag: targetBlock });
  const checks: ReserveCheck[] = [];
  let failed = false;

  for (const asset of reserves) {
    const configuration = await pool.getConfiguration(asset, { blockTag: targetBlock });
    const configurationData = readStructField<BigNumber>(configuration, 'data', 0);
    const reserveData = await pool.getReserveData(asset, { blockTag: targetBlock });
    const stableDebtTokenAddress = readStructField<string>(
      reserveData,
      'stableDebtTokenAddress',
      9
    );
    const stableDebtToken = await hre.ethers.getContractAt('IERC20', stableDebtTokenAddress);
    const underlying = await hre.ethers.getContractAt('IERC20Detailed', asset);

    checks.push({
      asset,
      symbol: await underlying.symbol({ blockTag: targetBlock }),
      liquidationThreshold: readUint16(configurationData, LIQUIDATION_THRESHOLD_START_BIT_POSITION),
      liquidationBonus: readUint16(configurationData, LIQUIDATION_BONUS_START_BIT_POSITION),
      stableBorrowingEnabled: isFlagSet(
        configurationData,
        STABLE_BORROWING_ENABLED_START_BIT_POSITION
      ),
      stableDebtSupply: await stableDebtToken.totalSupply({ blockTag: targetBlock }),
      unbacked: readStructField<BigNumber>(reserveData, 'unbacked', 13),
    });
  }

  const bridge = await scanBridgeRole(aclManager, targetBlock);
  const requireZeroSentinel = process.env.ROUNDING_PATCH_REQUIRE_ZERO_SENTINEL !== 'false';

  console.log(`Neverland rounding-patch live assumptions at block ${targetBlock}`);
  console.log(`PoolAddressesProvider: ${addressesProvider.address}`);
  console.log(`Pool: ${poolAddress}`);
  console.log(`ACLManager: ${aclManagerAddress}`);
  console.log(`PriceOracleSentinel: ${sentinelAddress}`);
  console.log(`BRIDGE_ROLE: ${bridge.bridgeRole}`);
  console.log('');

  if (requireZeroSentinel && sentinelAddress !== ZERO_ADDRESS) {
    console.error(`FAIL sentinel: expected zero address, got ${sentinelAddress}`);
    failed = true;
  }

  if (bridge.grants.length !== 0) {
    console.error(
      `FAIL bridge role: historical BRIDGE_ROLE grants found: ${bridge.grants.join(', ')}`
    );
    failed = true;
  }

  if (bridge.activeMembers.length !== 0) {
    console.error(
      `FAIL bridge role: active BRIDGE_ROLE members found: ${bridge.activeMembers.join(', ')}`
    );
    failed = true;
  }

  for (const check of checks) {
    const badStableFlag = check.stableBorrowingEnabled;
    const badStableSupply = !check.stableDebtSupply.eq(0);
    const badUnbacked = !check.unbacked.eq(0);
    const badCollateralPairing = check.liquidationThreshold.eq(0)
      ? !check.liquidationBonus.eq(0)
      : !check.liquidationBonus.gt(PERCENTAGE_FACTOR);
    const status =
      badStableFlag || badStableSupply || badUnbacked || badCollateralPairing ? 'FAIL' : 'OK';

    console.log(
      `${status} ${check.symbol} ${check.asset} stableBorrowing=${
        check.stableBorrowingEnabled
      } stableDebt=${check.stableDebtSupply.toString()} unbacked=${check.unbacked.toString()} lt=${check.liquidationThreshold.toString()} bonus=${check.liquidationBonus.toString()}`
    );

    if (badCollateralPairing) {
      console.error(
        `FAIL collateral params: ${
          check.symbol
        } has lt=${check.liquidationThreshold.toString()} bonus=${check.liquidationBonus.toString()}`
      );
    }

    if (badStableFlag || badStableSupply || badUnbacked || badCollateralPairing) failed = true;
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('All live assumptions satisfied.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
