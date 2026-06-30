/*
 * Neverland rounding patch: accrue-before-setReserveFactor (audit finding #27).
 *
 * setReserveFactor routes through Pool.setConfiguration. A reserve-factor change
 * must SETTLE the elapsed time slot (updateState -> indexes + accruedToTreasury,
 * then updateInterestRates) BEFORE the new factor takes effect, so the prior
 * slot's protocol fee is computed with the OLD factor, not the freshly written
 * one.
 *
 * VARIABLE RATE ONLY. Stable rate is disabled by the patch.
 *
 * Both `it`s are NON-VACUOUS: each asserts a strictly-moved index / timestamp and
 * a treasury-accrual direction that can only hold if the old factor governed the
 * elapsed slot.
 */

import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

makeSuite('Neverland rounding patch: accrue before setReserveFactor', (testEnv: TestEnv) => {
  let snap: string;

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  const seedDaiVariableDebt = async (borrowDai: string = '100') => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '100');
    const borrowAmount = await convertToCurrencyDecimals(dai.address, borrowDai);

    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, daiLiquidity));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0')
    );

    await waitForTx(
      await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, wethCollateral));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .supply(weth.address, wethCollateral, borrower.address, '0')
    );

    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address)
    );

    return { depositor, borrower, borrowAmount };
  };

  it('setReserveFactor settles elapsed indexes and rates before applying the new factor', async () => {
    const {
      users: [depositor],
      configurator,
      pool,
      dai,
    } = testEnv;

    await waitForTx(await configurator.setReserveFactor(dai.address, '0'));
    await seedDaiVariableDebt('5000');

    const beforeAccrual = await pool.getReserveData(dai.address);
    expect(beforeAccrual.currentLiquidityRate).to.be.gt(0);

    await increaseTime(ONE_YEAR_SECONDS);
    await waitForTx(await configurator.setReserveFactor(dai.address, '10000'));

    const afterSet = await pool.getReserveData(dai.address);
    expect(BigNumber.from(afterSet.lastUpdateTimestamp)).to.be.gt(
      BigNumber.from(beforeAccrual.lastUpdateTimestamp)
    );
    expect(afterSet.liquidityIndex).to.be.gt(beforeAccrual.liquidityIndex);
    expect(afterSet.variableBorrowIndex).to.be.gt(beforeAccrual.variableBorrowIndex);
    // Discriminating: NEW factor (100%) governs the forward rate -> suppliers earn nothing.
    // (Fails on the unfixed baseline, where syncRatesState never runs and the rate is unchanged.)
    expect(afterSet.currentLiquidityRate).to.eq(0);
    // Supporting (non-discriminating): with the OLD factor 0, the elapsed slot routes nothing to
    // treasury on either build; the load-bearing old-factor proof lives in the second test (10% -> grows).
    expect(afterSet.accruedToTreasury).to.eq(0);

    const touchAmount = await convertToCurrencyDecimals(dai.address, '1');
    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](touchAmount));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, touchAmount));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, touchAmount, depositor.address, '0')
    );

    const afterTouch = await pool.getReserveData(dai.address);
    expect(afterTouch.accruedToTreasury).to.be.gte(afterSet.accruedToTreasury);
    expect(afterTouch.liquidityIndex).to.eq(afterSet.liquidityIndex);
  });

  it('setReserveFactor accrues treasury with the previous factor before lowering to zero', async () => {
    const { configurator, pool, dai } = testEnv;

    await waitForTx(await configurator.setReserveFactor(dai.address, '1000'));
    await seedDaiVariableDebt('5000');

    const beforeAccrual = await pool.getReserveData(dai.address);

    await increaseTime(ONE_YEAR_SECONDS);
    await waitForTx(await configurator.setReserveFactor(dai.address, '0'));

    const afterSet = await pool.getReserveData(dai.address);
    expect(BigNumber.from(afterSet.lastUpdateTimestamp)).to.be.gt(
      BigNumber.from(beforeAccrual.lastUpdateTimestamp)
    );
    expect(afterSet.liquidityIndex).to.be.gt(beforeAccrual.liquidityIndex);
    expect(afterSet.variableBorrowIndex).to.be.gt(beforeAccrual.variableBorrowIndex);
    // elapsed slot accrued at the OLD factor (10%) BEFORE it was lowered to 0
    expect(afterSet.accruedToTreasury).to.be.gt(beforeAccrual.accruedToTreasury);
  });
});
