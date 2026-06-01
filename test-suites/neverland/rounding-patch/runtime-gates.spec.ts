import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { getFirstSigner } from '@aave/deploy-v3/dist/helpers/utilities/signer';
import { expect } from 'chai';
import { BigNumberish } from 'ethers';
import { ethers } from 'hardhat';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

declare var hre: any;

makeSuite('Neverland rounding patch runtime gates', (testEnv: TestEnv) => {
  let snapId: string;

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  const prepareBorrow = async () => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
      configurator,
      poolAdmin,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '10000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '10');

    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, 0)
    );

    await waitForTx(
      await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, 0)
    );

    await waitForTx(
      await configurator.connect(poolAdmin.signer).setReserveStableRateBorrowing(dai.address, true)
    );

    return { borrower, depositor, pool, dai };
  };

  const buildInitReserveInput = async (
    decimals: BigNumberish,
    inputDecimals: BigNumberish,
    symbol: string,
    treasury?: string
  ) => {
    const { addressesProvider, pool } = testEnv;
    const signer = await getFirstSigner();
    const MintableERC20Factory = await ethers.getContractFactory('MintableERC20', signer);
    const StableDebtTokenFactory = await ethers.getContractFactory('StableDebtToken', signer);
    const VariableDebtTokenFactory = await ethers.getContractFactory('VariableDebtToken', signer);
    const ATokenFactory = await ethers.getContractFactory('AToken', signer);
    const MockRateStrategyFactory = await ethers.getContractFactory(
      'MockReserveInterestRateStrategy',
      signer
    );
    const mockToken = await MintableERC20Factory.deploy(symbol, symbol, decimals);
    const stableDebtTokenImplementation = await StableDebtTokenFactory.deploy(pool.address);
    const variableDebtTokenImplementation = await VariableDebtTokenFactory.deploy(pool.address);
    const aTokenImplementation = await ATokenFactory.deploy(pool.address);
    const mockRateStrategy = await MockRateStrategyFactory.deploy(
      addressesProvider.address,
      0,
      0,
      0,
      0,
      0,
      0
    );

    return {
      aTokenImpl: aTokenImplementation.address,
      stableDebtTokenImpl: stableDebtTokenImplementation.address,
      variableDebtTokenImpl: variableDebtTokenImplementation.address,
      underlyingAssetDecimals: inputDecimals,
      interestRateStrategyAddress: mockRateStrategy.address,
      underlyingAsset: mockToken.address,
      treasury: treasury || signer.address,
      incentivesController: ZERO_ADDRESS,
      aTokenName: `A${symbol}`,
      aTokenSymbol: `A${symbol}`,
      variableDebtTokenName: `V${symbol}`,
      variableDebtTokenSymbol: `V${symbol}`,
      stableDebtTokenName: `S${symbol}`,
      stableDebtTokenSymbol: `S${symbol}`,
      params: '0x10',
    };
  };

  it('hard-reverts portal and bridge entrypoints at runtime', async () => {
    const {
      users: [user],
      pool,
      dai,
    } = testEnv;

    await expect(
      pool.connect(user.signer).mintUnbacked(dai.address, 1, user.address, 0)
    ).to.be.revertedWith('Neverland: portal/bridge disabled');

    await expect(pool.connect(user.signer).backUnbacked(dai.address, 1, 0)).to.be.revertedWith(
      'Neverland: portal/bridge disabled'
    );
  });

  it('deploys the Pool implementation with patched logic libraries and without BridgeLogic', async () => {
    const poolImpl = await hre.deployments.get('Pool-Implementation');
    const deployedCode = (await ethers.provider.getCode(poolImpl.address)).toLowerCase();

    for (const libraryName of [
      'BorrowLogic',
      'EModeLogic',
      'FlashLoanLogic',
      'LiquidationLogic',
      'PoolLogic',
      'SupplyLogic',
    ]) {
      const library = await hre.deployments.get(libraryName);
      expect(deployedCode, `${libraryName} link missing`).to.include(
        library.address.slice(2).toLowerCase()
      );
    }

    const bridgeLogic = await hre.deployments.get('BridgeLogic');
    expect(deployedCode).to.not.include(bridgeLogic.address.slice(2).toLowerCase());
  });

  it('initializes reserve decimals from the asset and rejects sub-6-decimal assets', async () => {
    const { configurator, poolAdmin, helpersContract } = testEnv;

    const mismatchedInput = await buildInitReserveInput(18, 6, 'NLD18');
    await waitForTx(await configurator.connect(poolAdmin.signer).initReserves([mismatchedInput]));

    const config = await helpersContract.getReserveConfigurationData(
      mismatchedInput.underlyingAsset
    );
    expect(config.decimals).to.eq(18, 'reserve decimals must come from the token');

    const lowDecimalsInput = await buildInitReserveInput(5, 18, 'NLD5');
    await expect(
      configurator.connect(poolAdmin.signer).initReserves([lowDecimalsInput])
    ).to.be.revertedWith(ProtocolErrors.INVALID_DECIMALS);
  });

  it('rejects reserve initialization with a zero AToken treasury', async () => {
    const { configurator, poolAdmin } = testEnv;
    const input = await buildInitReserveInput(18, 18, 'NLDTREASURY', ZERO_ADDRESS);

    await expect(configurator.connect(poolAdmin.signer).initReserves([input])).to.be.revertedWith(
      ProtocolErrors.ZERO_ADDRESS_NOT_VALID
    );
  });

  it('rejects AToken implementation updates with a zero treasury', async () => {
    const { aDai, configurator, dai, pool, poolAdmin } = testEnv;
    const signer = await getFirstSigner();
    const ATokenFactory = await ethers.getContractFactory('AToken', signer);
    const aTokenImplementation = await ATokenFactory.deploy(pool.address);

    await expect(
      configurator.connect(poolAdmin.signer).updateAToken({
        asset: dai.address,
        treasury: ZERO_ADDRESS,
        incentivesController: await aDai.getIncentivesController(),
        name: await aDai.name(),
        symbol: await aDai.symbol(),
        implementation: aTokenImplementation.address,
        params: '0x',
      })
    ).to.be.revertedWith(ProtocolErrors.ZERO_ADDRESS_NOT_VALID);
  });

  it('stable-rate borrow remains disabled even if the reserve flag is enabled', async () => {
    const { borrower, pool, dai } = await prepareBorrow();
    const borrowAmount = await convertToCurrencyDecimals(dai.address, '100');

    await expect(
      pool
        .connect(borrower.signer)
        .borrow(dai.address, borrowAmount, RateMode.Stable, 0, borrower.address)
    ).to.be.revertedWith(ProtocolErrors.STABLE_BORROWING_NOT_ENABLED);
  });

  it('stable-rate swap, rebalance, and repay entrypoints remain disabled at runtime', async () => {
    const { borrower, depositor, pool, dai } = await prepareBorrow();
    const borrowAmount = await convertToCurrencyDecimals(dai.address, '100');

    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, borrowAmount, RateMode.Variable, 0, borrower.address)
    );

    await expect(
      pool.connect(borrower.signer).swapBorrowRateMode(dai.address, RateMode.Variable)
    ).to.be.revertedWith(ProtocolErrors.STABLE_BORROWING_NOT_ENABLED);

    await expect(
      pool.connect(depositor.signer).rebalanceStableBorrowRate(dai.address, borrower.address)
    ).to.be.revertedWith(ProtocolErrors.STABLE_BORROWING_NOT_ENABLED);

    await expect(
      pool.connect(borrower.signer).repay(dai.address, 1, RateMode.Stable, borrower.address)
    ).to.be.revertedWith(ProtocolErrors.STABLE_BORROWING_NOT_ENABLED);
  });
});
