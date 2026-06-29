import { Signer } from 'ethers';
import { BigNumber } from '@ethersproject/bignumber';
import {
  getPool,
  getPoolAddressesProvider,
  getAaveProtocolDataProvider,
  getAToken,
  getMintableERC20,
  getPoolConfiguratorProxy,
  getPoolAddressesProviderRegistry,
  getWETHMocked,
  getVariableDebtToken,
  getStableDebtToken,
  getAaveOracle,
  getACLManager,
} from '@aave/deploy-v3/dist/helpers/contract-getters';
import {
  waitForTx,
  evmSnapshot,
  evmRevert,
  getEthersSigners,
  deployPriceOracle,
  Faucet,
  getFaucet,
} from '@aave/deploy-v3';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { usingTenderly } from '../../helpers/tenderly-utils';
import { tEthereumAddress } from '../../helpers/types';

declare var hre: HardhatRuntimeEnvironment;

export interface SignerWithAddress {
  signer: Signer;
  address: tEthereumAddress;
}
export interface TestEnv {
  deployer: SignerWithAddress;
  poolAdmin: SignerWithAddress;
  emergencyAdmin: SignerWithAddress;
  riskAdmin: SignerWithAddress;
  users: SignerWithAddress[];
  pool: any;
  configurator: any;
  oracle: any;
  aaveOracle: any;
  helpersContract: any;
  weth: any;
  aWETH: any;
  faucetMintable: Faucet;
  dai: any;
  aDai: any;
  aAave: any;
  variableDebtDai: any;
  stableDebtDai: any;
  aUsdc: any;
  usdc: any;
  aave: any;
  addressesProvider: any;
  registry: any;
  aclManager: any;
}

let HardhatSnapshotId: string = '0x1';
const setHardhatSnapshotId = (id: string) => {
  HardhatSnapshotId = id;
};

const testEnv: TestEnv = {
  deployer: {} as SignerWithAddress,
  poolAdmin: {} as SignerWithAddress,
  emergencyAdmin: {} as SignerWithAddress,
  riskAdmin: {} as SignerWithAddress,
  users: [] as SignerWithAddress[],
  pool: {},
  configurator: {},
  helpersContract: {},
  oracle: {},
  aaveOracle: {},
  weth: {},
  aWETH: {},
  faucetMintable: {} as Faucet,
  dai: {},
  aDai: {},
  variableDebtDai: {},
  stableDebtDai: {},
  aUsdc: {},
  usdc: {},
  aave: {},
  addressesProvider: {},
  registry: {},
  aclManager: {},
} as TestEnv;

export async function initializeMakeSuite() {
  const [_deployer, ...restSigners] = await getEthersSigners();
  const deployer: SignerWithAddress = {
    address: await _deployer.getAddress(),
    signer: _deployer,
  };

  for (const signer of restSigners) {
    testEnv.users.push({
      signer,
      address: await signer.getAddress(),
    });
  }
  testEnv.deployer = deployer;
  testEnv.poolAdmin = deployer;
  testEnv.emergencyAdmin = testEnv.users[1];
  testEnv.riskAdmin = testEnv.users[2];
  testEnv.pool = await getPool();
  testEnv.configurator = await getPoolConfiguratorProxy();

  testEnv.addressesProvider = await getPoolAddressesProvider();

  testEnv.registry = await getPoolAddressesProviderRegistry();
  testEnv.aclManager = await getACLManager();

  testEnv.oracle = await deployPriceOracle();
  testEnv.aaveOracle = await getAaveOracle();

  testEnv.helpersContract = await getAaveProtocolDataProvider();

  const allTokens = await testEnv.helpersContract.getAllATokens();
  const aDaiAddress = allTokens.find((aToken) => aToken.symbol.includes('DAI'))?.tokenAddress;
  const aUsdcAddress = allTokens.find((aToken) => aToken.symbol.includes('USDC'))?.tokenAddress;
  const aWEthAddress = allTokens.find((aToken) => aToken.symbol.includes('WETH'))?.tokenAddress;
  const aAaveAddress = allTokens.find((aToken) => aToken.symbol.includes('AAVE'))?.tokenAddress;

  const reservesTokens = await testEnv.helpersContract.getAllReservesTokens();

  const daiAddress = reservesTokens.find((token) => token.symbol === 'DAI')?.tokenAddress;
  const {
    variableDebtTokenAddress: variableDebtDaiAddress,
    stableDebtTokenAddress: stableDebtDaiAddress,
  } = await testEnv.helpersContract.getReserveTokensAddresses(daiAddress || '');
  const usdcAddress = reservesTokens.find((token) => token.symbol === 'USDC')?.tokenAddress;
  const aaveAddress = reservesTokens.find((token) => token.symbol === 'AAVE')?.tokenAddress;
  const wethAddress = reservesTokens.find((token) => token.symbol === 'WETH')?.tokenAddress;

  if (!aDaiAddress || !aWEthAddress) {
    throw 'Missing mandatory atokens';
  }
  if (!daiAddress || !usdcAddress || !aaveAddress || !wethAddress) {
    throw 'Missing mandatory tokens';
  }

  testEnv.faucetMintable = await getFaucet();
  testEnv.aDai = await getAToken(aDaiAddress);
  testEnv.variableDebtDai = await getVariableDebtToken(variableDebtDaiAddress);
  testEnv.stableDebtDai = await getStableDebtToken(stableDebtDaiAddress);
  testEnv.aUsdc = await getAToken(aUsdcAddress);
  testEnv.aWETH = await getAToken(aWEthAddress);
  testEnv.aAave = await getAToken(aAaveAddress);

  testEnv.dai = await getMintableERC20(daiAddress);
  testEnv.aave = await getMintableERC20(aaveAddress);
  testEnv.usdc = await getMintableERC20(usdcAddress);
  testEnv.weth = await getWETHMocked(wethAddress);

  // Support direct minting
  const testReserves = reservesTokens.map((x) => x.tokenAddress);
  await waitForTx(await testEnv.faucetMintable.setProtectedOfChild(testReserves, false));

  // Setup Fallback Oracle and feed up with current AaveOracle prices
  for (const testReserve of testReserves) {
    const price = await testEnv.aaveOracle.getAssetPrice(testReserve);
    await waitForTx(await testEnv.oracle.setAssetPrice(testReserve, price));
  }
  await waitForTx(await testEnv.aaveOracle.setFallbackOracle(testEnv.oracle.address));

  // Setup admins
  await waitForTx(await testEnv.aclManager.addRiskAdmin(testEnv.riskAdmin.address));
  await waitForTx(await testEnv.aclManager.addEmergencyAdmin(testEnv.emergencyAdmin.address));
}

const setSnapshot = async () => {
  if (usingTenderly()) {
    setHardhatSnapshotId((await hre.tenderlyNetwork.getHead()) || '0x1');
    return;
  }
  setHardhatSnapshotId(await evmSnapshot());
};

const revertHead = async () => {
  if (usingTenderly()) {
    await hre.tenderlyNetwork.setHead(HardhatSnapshotId);
    return;
  }
  await evmRevert(HardhatSnapshotId);
};

export function makeSuite(name: string, tests: (testEnv: TestEnv) => void) {
  describe(name, () => {
    before(async () => {
      await setSnapshot();
    });
    tests(testEnv);
    after(async () => {
      await revertHead();
    });
  });
}
