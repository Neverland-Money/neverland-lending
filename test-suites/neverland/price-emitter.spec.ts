import { evmRevert, evmSnapshot } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { TransactionReceipt } from '@ethersproject/providers';
import { MAX_UINT_AMOUNT, oneEther } from '../../helpers/constants';
import { convertToCurrencyDecimals } from '../../helpers/contracts-helpers';
import { RateMode } from '../../helpers/types';
import { makeSuite, TestEnv } from '../helpers/make-suite';
import '../helpers/utils/wadraymath';

const ACTION_SUPPLY = 1;
const ACTION_BORROW = 2;
const ACTION_REPAY = 3;
const ACTION_LIQUIDATION = 6;
const ACTION_WITHDRAW = 7;
const ACTION_ATOKEN_TRANSFER = 8;

const getPriceObservedEvents = (token: any, receipt: TransactionReceipt) =>
  receipt.logs
    .filter((log) => log.address.toLowerCase() === token.address.toLowerCase())
    .map((log) => {
      try {
        return token.interface.parseLog(log);
      } catch {
        return undefined;
      }
    })
    .filter((event) => event?.name === 'PriceObserved');

const expectPriceObserved = async (
  token: any,
  receipt: TransactionReceipt,
  asset: string,
  action: number,
  user: string,
  oracle: any
) => {
  const event = getPriceObservedEvents(token, receipt).find(
    (item) => item?.args.action === action && item?.args.user === user
  );

  expect(event, `missing PriceObserved action ${action}`).to.not.be.undefined;
  expect(event?.args.asset).to.be.eq(asset);
  expect(event?.args.price).to.be.eq(await oracle.getAssetPrice(asset));
  const baseUnit = oracle.BASE_CURRENCY_UNIT
    ? await oracle.BASE_CURRENCY_UNIT()
    : BigNumber.from(0);
  expect(event?.args.baseUnit).to.be.eq(baseUnit);
  expect(event?.args.oracle).to.be.eq(oracle.address);
  expect(event?.args.ok).to.be.true;
};

makeSuite('PriceEmitter', (testEnv: TestEnv) => {
  let snapId: string;

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  it('emits prices for supply, transfer, and withdraw', async () => {
    const {
      users: [supplier, receiver],
      pool,
      dai,
      aDai,
      aaveOracle,
    } = testEnv;

    const supplyAmount = await convertToCurrencyDecimals(dai.address, '1000');
    const transferAmount = await convertToCurrencyDecimals(dai.address, '10');
    const withdrawAmount = await convertToCurrencyDecimals(dai.address, '5');

    await dai.connect(supplier.signer)['mint(uint256)'](supplyAmount);
    await dai.connect(supplier.signer).approve(pool.address, MAX_UINT_AMOUNT);

    let tx = await pool
      .connect(supplier.signer)
      .supply(dai.address, supplyAmount, supplier.address, '0');
    await expectPriceObserved(
      aDai,
      await tx.wait(),
      dai.address,
      ACTION_SUPPLY,
      supplier.address,
      aaveOracle
    );

    tx = await aDai.connect(supplier.signer).transfer(receiver.address, transferAmount);
    await expectPriceObserved(
      aDai,
      await tx.wait(),
      dai.address,
      ACTION_ATOKEN_TRANSFER,
      supplier.address,
      aaveOracle
    );

    tx = await pool
      .connect(supplier.signer)
      .withdraw(dai.address, withdrawAmount, supplier.address);
    await expectPriceObserved(
      aDai,
      await tx.wait(),
      dai.address,
      ACTION_WITHDRAW,
      supplier.address,
      aaveOracle
    );
  });

  it('emits prices for variable borrow and repay', async () => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
      variableDebtDai,
      aaveOracle,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '10000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '10');
    const borrowAmount = await convertToCurrencyDecimals(dai.address, '100');

    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');

    let tx = await pool
      .connect(borrower.signer)
      .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address);
    await expectPriceObserved(
      variableDebtDai,
      await tx.wait(),
      dai.address,
      ACTION_BORROW,
      borrower.address,
      aaveOracle
    );

    await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    tx = await pool
      .connect(borrower.signer)
      .repay(dai.address, borrowAmount.div(2), RateMode.Variable, borrower.address);
    await expectPriceObserved(
      variableDebtDai,
      await tx.wait(),
      dai.address,
      ACTION_REPAY,
      borrower.address,
      aaveOracle
    );
  });

  it('emits prices when liquidation transfers collateral as aToken', async () => {
    const {
      users: [depositor, borrower, liquidator],
      pool,
      dai,
      weth,
      aWETH,
      oracle,
      addressesProvider,
      helpersContract,
    } = testEnv;

    await addressesProvider.setPriceOracle(oracle.address);

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '1000');
    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    const wethCollateral = await convertToCurrencyDecimals(weth.address, '0.3');
    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');

    const userGlobalData = await pool.getUserAccountData(borrower.address);
    const daiPrice = await oracle.getAssetPrice(dai.address);
    const amountToBorrow = await convertToCurrencyDecimals(
      dai.address,
      userGlobalData.availableBorrowsBase.div(daiPrice).percentMul(9500).toString()
    );

    await pool
      .connect(borrower.signer)
      .borrow(dai.address, amountToBorrow, RateMode.Variable, '0', borrower.address);

    await oracle.setAssetPrice(dai.address, daiPrice.percentMul(11500));
    expect((await pool.getUserAccountData(borrower.address)).healthFactor).to.be.lt(oneEther);

    await dai.connect(liquidator.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT);

    const userReserveData = await helpersContract.getUserReserveData(dai.address, borrower.address);
    const tx = await pool
      .connect(liquidator.signer)
      .liquidationCall(
        weth.address,
        dai.address,
        borrower.address,
        userReserveData.currentVariableDebt.div(BigNumber.from(2)),
        true
      );
    const receipt = await tx.wait();

    await expectPriceObserved(
      aWETH,
      receipt,
      weth.address,
      ACTION_LIQUIDATION,
      borrower.address,
      oracle
    );
    await expectPriceObserved(
      aWETH,
      receipt,
      weth.address,
      ACTION_ATOKEN_TRANSFER,
      borrower.address,
      oracle
    );
  });
});
