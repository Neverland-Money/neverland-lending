/*
 * Isolation-mode debt-accounting lifecycle pins on the REAL patched Pool
 * (ATokenPEV3 + VariableDebtTokenPEV2), expressed on the LENDING makeSuite
 * harness.
 *
 * WHAT THIS PINS
 * --------------
 * The rounding patch makes isolation-mode `isolationModeTotalDebt` accounting
 * track the REALIZED (ceil-aligned) debt the variable-debt leaf actually
 * mints/burns, never the raw `params.amount` / `paybackAmount` / `debtToCover`:
 *
 *   - executeBorrow (increment):
 *       realizedBorrow   = vToken.balanceOf(borrower)_post - _pre
 *       isolationModeTotalDebt += realizedBorrow / 10^(debtDecimals - 2)
 *   - executeRepay (decrement, partial):
 *       realizedRepay = vToken.balanceOf(borrower)_pre - _postBurn
 *       isolationModeTotalDebt -= realizedRepay / 10^(debtDecimals - 2)
 *   - executeRepay (FULL, uint256.max): nets isolationModeTotalDebt back to the
 *       starting value EXACTLY (round-trip identity) and clears the borrowing
 *       flag when the post-burn balance hits 0.
 *   - liquidationCall (decrement): by the realized burned debt
 *       (priorDebt - debtAfter) / 10^(debtDecimals - 2), NOT raw debtToCover.
 *
 * NON-VACUITY
 * -----------
 * The debt asset is the 6-decimal USDC reserve (CEILING_DIVISOR = 10^(6-2) =
 * 10^4) so residue effects bite at small absolute amounts. A debt-pusher posts
 * WETH (non-isolation collateral, so the pusher itself is NOT in isolation
 * mode) and borrows USDC to high utilization; we then advance time so the USDC
 * variable borrow index drifts strictly above RAY. Every test asserts the index
 * moved (> RAY) before relying on the residue, asserts a positive observable
 * effect (counter == K, balance strictly changed), and contrasts the patched
 * realized-delta against the raw-amount scheme it replaced, so a silent
 * early-revert or a regression to raw-amount accounting fails the pin.
 */

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import {
  evmSnapshot,
  evmRevert,
  increaseTime,
  advanceTimeAndBlock,
  waitForTx,
} from '@aave/deploy-v3';
import { MAX_UINT_AMOUNT, oneEther } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import '../../helpers/utils/wadraymath'; // adds BigNumber.prototype.percentMul / rayMul
import { getVariableDebtToken } from '@aave/deploy-v3/dist/helpers/contract-getters';

const RAY = BigNumber.from(10).pow(27);

// AAVE is the isolated collateral (18-dec, not borrowable-in-isolation); we set
// a debt ceiling so a borrower whose ONLY collateral is AAVE is in isolation
// mode. USDC is the 6-decimal borrowable-in-isolation debt asset.
//
// CEILING_DIVISOR = 10^(debtDecimals - DEBT_CEILING_DECIMALS); DEBT_CEILING
// precision is 2 (cents). USDC has 6 decimals => 10^(6-2) = 10^4.
const USDC_DECIMALS = 6;
const DEBT_CEILING_DECIMALS = 2;
const CEILING_DIVISOR = BigNumber.from(10).pow(USDC_DECIMALS - DEBT_CEILING_DECIMALS); // 10^4

// Generous AAVE debt ceiling (cents precision) so we comfortably borrow many
// ceiling units without tripping DEBT_CEILING_EXCEEDED.
const AAVE_DEBT_CEILING = '100000000'; // $1,000,000.00

makeSuite('Neverland rounding patch: isolation-mode debt accounting', (testEnv: TestEnv) => {
  let snap: string;

  // Resolve the USDC variable-debt token once (read-only across the suite).
  const getUsdcVDebt = async () => {
    const { helpersContract, usdc } = testEnv;
    const { variableDebtTokenAddress } = await helpersContract.getReserveTokensAddresses(
      usdc.address
    );
    return getVariableDebtToken(variableDebtTokenAddress);
  };

  // isolationModeTotalDebt is keyed by the isolated COLLATERAL reserve (AAVE).
  const isoTotalDebt = async (): Promise<BigNumber> =>
    (await testEnv.pool.getReserveData(testEnv.aave.address)).isolationModeTotalDebt;

  // Borrowing-flag bit for reserve id `i` is bit 2*i of the packed user config.
  const usdcBorrowingFlagSet = async (user: string): Promise<boolean> => {
    const { pool, usdc } = testEnv;
    const cfg = (await pool.getUserConfiguration(user)).data as BigNumber;
    const reserveId = (await pool.getReserveData(usdc.address)).id;
    return cfg
      .shr(2 * Number(reserveId))
      .and(1)
      .eq(1);
  };

  /**
   * Seeds USDC liquidity, sets the AAVE debt ceiling, and drifts the USDC
   * variable borrow index strictly above RAY via a WETH-backed debt-pusher
   * (non-isolation collateral, so the pusher is not itself in isolation mode).
   * Returns the post-drift USDC variable index for non-vacuity assertions.
   */
  const driftUsdcIndexAboveRay = async (): Promise<BigNumber> => {
    const {
      users: [liquidityProvider, , , debtPusher],
      pool,
      usdc,
      weth,
      configurator,
      poolAdmin,
      helpersContract,
    } = testEnv;

    // Isolated collateral: give AAVE a positive debt ceiling so a borrower whose
    // ONLY collateral is AAVE is in isolation mode.
    await waitForTx(
      await configurator
        .connect(poolAdmin.signer)
        .setDebtCeiling(testEnv.aave.address, AAVE_DEBT_CEILING)
    );

    // Debt asset: mark USDC borrowable-in-isolation. The LENDING deploy
    // `configureReservesByHelper` applies collateral/borrowing params but NEVER
    // the `borrowableIsolation` / `debtCeiling` market flags, so without this an
    // isolated borrow of USDC reverts ASSET_NOT_BORROWABLE_IN_ISOLATION ('60').
    // (Mirrors the template test-suites/isolation-mode.spec.ts before-hook.)
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setBorrowableInIsolation(usdc.address, true)
    );

    // Non-vacuity: confirm the isolation market config actually took, so the
    // realized-vs-raw pins below run against a genuinely isolated borrow path
    // rather than passing because the borrow silently no-op'd.
    expect(
      await helpersContract.getDebtCeiling(testEnv.aave.address),
      'AAVE debt ceiling must be positive (isolation mode active)'
    ).to.be.gt(0);
    expect(
      (await helpersContract.getReserveConfigurationData(usdc.address)).borrowingEnabled,
      'USDC borrowing must be enabled'
    ).to.equal(true);

    // Seed a large USDC pool so the borrower's borrow is a small fraction and
    // the pusher can crank utilization without exhausting liquidity.
    const usdcLiquidity = await convertToCurrencyDecimals(usdc.address, '2000000');
    await usdc
      .connect(liquidityProvider.signer)
      ['mint(address,uint256)'](liquidityProvider.address, usdcLiquidity);
    await usdc.connect(liquidityProvider.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(liquidityProvider.signer)
      .supply(usdc.address, usdcLiquidity, liquidityProvider.address, '0');

    // Debt-pusher posts WETH (LTV 8000, non-isolation) and borrows USDC to high
    // utilization to push the variable rate into slope2, then time advances.
    const pusherWeth = await convertToCurrencyDecimals(weth.address, '2000');
    await weth.connect(debtPusher.signer)['mint(address,uint256)'](debtPusher.address, pusherWeth);
    await weth.connect(debtPusher.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(debtPusher.signer).supply(weth.address, pusherWeth, debtPusher.address, '0');

    const pusherBorrow = await convertToCurrencyDecimals(usdc.address, '1800000'); // 90% util
    await pool
      .connect(debtPusher.signer)
      .borrow(usdc.address, pusherBorrow, RateMode.Variable, '0', debtPusher.address);

    // Advance several years, then a state-touching tx (re-borrow a dust amount)
    // to crystallise the accrued index into the stored variableBorrowIndex.
    await advanceTimeAndBlock(5 * 365 * 24 * 60 * 60);
    await pool
      .connect(debtPusher.signer)
      .borrow(
        usdc.address,
        await convertToCurrencyDecimals(usdc.address, '1'),
        RateMode.Variable,
        '0',
        debtPusher.address
      );

    const idx = await pool.getReserveNormalizedVariableDebt(usdc.address);
    expect(idx, 'USDC variable index must be > RAY for a residue boundary').to.be.gt(RAY);
    return idx;
  };

  // Posts `aaveAmount` of AAVE for `signer` and enables it as collateral. The
  // post-supply toggle avoids needing ISOLATED_COLLATERAL_SUPPLIER_ROLE.
  const postIsolatedCollateral = async (signer: any, signerAddr: string, aaveAmount: BigNumber) => {
    const { pool, aave } = testEnv;
    await aave.connect(signer)['mint(address,uint256)'](signerAddr, aaveAmount);
    await aave.connect(signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(signer).supply(aave.address, aaveAmount, signerAddr, '0');
    await pool.connect(signer).setUserUseReserveAsCollateral(aave.address, true);
  };

  before(async () => {
    // Use the mutable PriceOracle so the liquidation test can drop the AAVE
    // price (the AaveOracle's MockAggregator has no setter).
    const { addressesProvider, oracle } = testEnv;
    await waitForTx(await addressesProvider.setPriceOracle(oracle.address));
  });

  after(async () => {
    const { addressesProvider, aaveOracle } = testEnv;
    await waitForTx(await addressesProvider.setPriceOracle(aaveOracle.address));
  });

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  it('borrow increments isolationModeTotalDebt by realizedBorrow/CEILING_DIVISOR (not raw amount) at an index > RAY', async function () {
    this.timeout(240_000);
    const {
      users: [, borrower],
      pool,
      usdc,
    } = testEnv;
    const usdcVDebt = await getUsdcVDebt();

    const idx = await driftUsdcIndexAboveRay();
    expect(idx).to.be.gt(RAY);

    // Borrower's ONLY collateral is AAVE => isolation mode.
    await postIsolatedCollateral(
      borrower.signer,
      borrower.address,
      await convertToCurrencyDecimals(testEnv.aave.address, '20000')
    );

    const isoStart = await isoTotalDebt();
    expect(isoStart).to.equal(0);

    // Non-round 6-decimal amount so the ceil-on-borrow residue bites.
    const borrowAmount = await convertToCurrencyDecimals(usdc.address, '1234.567891');

    const preDebt = await usdcVDebt.balanceOf(borrower.address);
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(usdc.address, borrowAmount, RateMode.Variable, '0', borrower.address)
    );
    const postDebt = await usdcVDebt.balanceOf(borrower.address);

    const realizedBorrow = postDebt.sub(preDebt);
    const expectedIncrement = realizedBorrow.div(CEILING_DIVISOR);
    const rawIncrement = borrowAmount.div(CEILING_DIVISOR);

    const isoAfter = await isoTotalDebt();

    // POSITIVE OBSERVABLE EFFECT: counter strictly increased, debt minted.
    expect(realizedBorrow).to.be.gt(0);
    expect(isoAfter).to.be.gt(isoStart);

    expect(isoAfter.sub(isoStart)).to.equal(
      expectedIncrement,
      `isolation increment must equal realizedBorrow ${realizedBorrow.toString()} / ` +
        `${CEILING_DIVISOR.toString()} = ${expectedIncrement.toString()}; a raw-amount scheme ` +
        `would have used borrowAmount ${borrowAmount.toString()} / ${CEILING_DIVISOR.toString()} = ` +
        `${rawIncrement.toString()}.`
    );

    // ceil-on-borrow at idx > RAY over-credits vs the raw request, so realized
    // >= raw and the realized increment >= the raw increment: a concrete
    // divergence opportunity the raw scheme would have under-counted.
    expect(realizedBorrow).to.be.gte(borrowAmount);
    expect(expectedIncrement).to.be.gte(rawIncrement);

    // Borrowing flag set after a fresh variable borrow.
    expect(await usdcBorrowingFlagSet(borrower.address)).to.equal(true);
  });

  it('partial repay decrements isolationModeTotalDebt by realizedPartial/CEILING_DIVISOR and keeps the borrowing flag set', async function () {
    this.timeout(240_000);
    const {
      users: [, borrower],
      pool,
      usdc,
    } = testEnv;
    const usdcVDebt = await getUsdcVDebt();

    await driftUsdcIndexAboveRay();
    await postIsolatedCollateral(
      borrower.signer,
      borrower.address,
      await convertToCurrencyDecimals(testEnv.aave.address, '20000')
    );

    const borrowAmount = await convertToCurrencyDecimals(usdc.address, '1234.567891');
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(usdc.address, borrowAmount, RateMode.Variable, '0', borrower.address)
    );

    const isoAfterBorrow = await isoTotalDebt();
    expect(isoAfterBorrow).to.be.gt(0);

    // Fund a generous buffer for accrual, then partially repay ~40%.
    await usdc
      .connect(borrower.signer)
      ['mint(address,uint256)'](
        borrower.address,
        await convertToCurrencyDecimals(usdc.address, '100000')
      );
    await usdc.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);

    // Accrue a little more before the partial repay so the residue is live.
    await increaseTime(30 * 24 * 60 * 60);

    const debtBefore = await usdcVDebt.balanceOf(borrower.address);
    const partialPayback = debtBefore.mul(40).div(100);
    expect(partialPayback).to.be.gt(0);

    const isoBeforePartial = await isoTotalDebt();
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .repay(usdc.address, partialPayback, RateMode.Variable, borrower.address)
    );
    const debtAfter = await usdcVDebt.balanceOf(borrower.address);
    const isoAfterPartial = await isoTotalDebt();

    // Realized debt change = balanceOf pre - post, NOT the raw partialPayback.
    const realizedPartial = debtBefore.sub(debtAfter);
    const expectedPartialDecrement = realizedPartial.div(CEILING_DIVISOR);
    const rawPartialDecrement = partialPayback.div(CEILING_DIVISOR);

    // POSITIVE OBSERVABLE EFFECT: debt strictly fell, counter strictly fell.
    expect(realizedPartial).to.be.gt(0);
    expect(isoAfterPartial).to.be.lt(isoBeforePartial);

    expect(isoBeforePartial.sub(isoAfterPartial)).to.equal(
      expectedPartialDecrement,
      `partial-repay decrement must equal realized debt change ${realizedPartial.toString()} / ` +
        `${CEILING_DIVISOR.toString()} = ${expectedPartialDecrement.toString()}; a raw-amount ` +
        `scheme would have used partialPayback ${partialPayback.toString()} / ` +
        `${CEILING_DIVISOR.toString()} = ${rawPartialDecrement.toString()}.`
    );

    // Debt remains, so isolation total debt is still positive and the borrowing
    // flag is still set.
    expect(debtAfter).to.be.gt(0);
    expect(isoAfterPartial).to.be.gt(0);
    expect(await usdcBorrowingFlagSet(borrower.address)).to.equal(true);
  });

  it('full repay(MAX) nets isolationModeTotalDebt back to start exactly and clears the borrowing flag', async function () {
    this.timeout(240_000);
    const {
      users: [, borrower],
      pool,
      usdc,
    } = testEnv;
    const usdcVDebt = await getUsdcVDebt();

    await driftUsdcIndexAboveRay();
    await postIsolatedCollateral(
      borrower.signer,
      borrower.address,
      await convertToCurrencyDecimals(testEnv.aave.address, '20000')
    );

    const isoStart = await isoTotalDebt();
    expect(isoStart).to.equal(0);

    const borrowAmount = await convertToCurrencyDecimals(usdc.address, '1234.567891');
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(usdc.address, borrowAmount, RateMode.Variable, '0', borrower.address)
    );

    // Partial repay first so the round-trip crosses a residue boundary on the
    // way down (exercises the IsolationModeLogic decrement twice).
    await usdc
      .connect(borrower.signer)
      ['mint(address,uint256)'](
        borrower.address,
        await convertToCurrencyDecimals(usdc.address, '100000')
      );
    await usdc.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await increaseTime(30 * 24 * 60 * 60);

    const debtBeforePartial = await usdcVDebt.balanceOf(borrower.address);
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .repay(
          usdc.address,
          debtBeforePartial.mul(40).div(100),
          RateMode.Variable,
          borrower.address
        )
    );

    const isoBeforeFull = await isoTotalDebt();
    expect(isoBeforeFull).to.be.gt(0);

    // FULL repay (uint256.max).
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .repay(usdc.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address)
    );
    const debtAfterFull = await usdcVDebt.balanceOf(borrower.address);
    const scaledAfterFull = await usdcVDebt.scaledBalanceOf(borrower.address);
    const isoAfterFull = await isoTotalDebt();

    // POSITIVE OBSERVABLE EFFECT: debt fully cleared, flag cleared.
    expect(debtAfterFull).to.equal(0);
    expect(scaledAfterFull).to.equal(0);
    expect(await usdcBorrowingFlagSet(borrower.address)).to.equal(false);

    // ROUND-TRIP IDENTITY: full repay decrements by the entire outstanding
    // realized debt, so the isolation total nets EXACTLY back to start. A
    // raw-amount decrement would subtract sum(raw paybacks) != outstanding
    // realized debt at this residue boundary and leave a nonzero residue.
    expect(isoAfterFull).to.equal(
      isoStart,
      `round-trip identity broken: isolationModeTotalDebt did not net back to the starting ` +
        `value ${isoStart.toString()} after full repay (got ${isoAfterFull.toString()}). The ` +
        `realized-delta scheme guarantees start == end; a raw-amount decrement would leave a ` +
        `residue here.`
    );
  });

  it('liquidationCall decrements isolationModeTotalDebt by the realized burned debt, not raw debtToCover', async function () {
    this.timeout(240_000);
    const {
      users: [, borrower, , , liquidator],
      pool,
      usdc,
      aave,
      oracle,
    } = testEnv;
    const usdcVDebt = await getUsdcVDebt();

    await driftUsdcIndexAboveRay();

    // Borrower posts AAVE and borrows USDC close to the LTV cap. Collateral is
    // sized so the ~95%-of-capacity USDC borrow (a) stays well under the AAVE
    // debt ceiling (its isolationModeTotalDebt contribution is borrow/1e4 in
    // cents) and (b) fits the USDC liquidity left after the debt-pusher's draw
    // (~200k of the 2M seed). 1000 AAVE @ $300, LTV 5000 => ~142.5k USDC borrow,
    // $142.5k of ceiling vs the $1,000,000 ceiling, and HF ~0.68 (< 1) after the
    // price halves so the liquidation still triggers.
    await postIsolatedCollateral(
      borrower.signer,
      borrower.address,
      await convertToCurrencyDecimals(aave.address, '1000')
    );

    const accountData = await pool.getUserAccountData(borrower.address);
    const usdcPrice = await oracle.getAssetPrice(usdc.address);
    // Canonical lending-spec conversion: availableBorrowsBase / price yields a
    // whole-token figure, then convertToCurrencyDecimals scales it to USDC's 6
    // decimals. Borrow ~95% of capacity (a non-round figure so the ceil residue
    // bites at the boundary).
    const borrowable = await convertToCurrencyDecimals(
      usdc.address,
      accountData.availableBorrowsBase.div(usdcPrice).percentMul(9500).toString()
    );
    expect(borrowable).to.be.gt(0);
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(usdc.address, borrowable, RateMode.Variable, '0', borrower.address)
    );

    const isoAfterBorrow = await isoTotalDebt();
    expect(isoAfterBorrow).to.be.gt(0);

    // Push the borrower underwater by dropping the AAVE collateral price.
    const aavePrice = await oracle.getAssetPrice(aave.address);
    await waitForTx(await oracle.setAssetPrice(aave.address, aavePrice.div(2)));

    const healthFactor = (await pool.getUserAccountData(borrower.address)).healthFactor;
    expect(healthFactor, 'borrower must be liquidatable').to.be.lt(oneEther);

    // Fund the liquidator with USDC.
    await usdc
      .connect(liquidator.signer)
      ['mint(address,uint256)'](
        liquidator.address,
        await convertToCurrencyDecimals(usdc.address, '1000000')
      );
    await usdc.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT);

    // 50%-close-factor debtToCover (non-round so the realized burn diverges from
    // raw at the residue boundary).
    const debtToCover = (await usdcVDebt.balanceOf(borrower.address)).div(2);
    expect(debtToCover).to.be.gt(0);

    const isoBefore = await isoTotalDebt();
    const priorDebt = await usdcVDebt.balanceOf(borrower.address);
    await waitForTx(
      await pool
        .connect(liquidator.signer)
        .liquidationCall(aave.address, usdc.address, borrower.address, debtToCover, false)
    );
    const debtAfter = await usdcVDebt.balanceOf(borrower.address);
    const isoAfter = await isoTotalDebt();

    // Realized post-burn debt change, NOT the raw debtToCover.
    const realizedBurned = priorDebt.sub(debtAfter);
    const expectedDecrement = realizedBurned.div(CEILING_DIVISOR);
    const rawDecrement = debtToCover.div(CEILING_DIVISOR);

    // POSITIVE OBSERVABLE EFFECT: debt strictly burned, counter strictly fell.
    expect(realizedBurned).to.be.gt(0);
    expect(isoAfter).to.be.lt(isoBefore);

    expect(isoBefore.sub(isoAfter)).to.equal(
      expectedDecrement,
      `liquidation decrement must equal realized debt change ${realizedBurned.toString()} / ` +
        `${CEILING_DIVISOR.toString()} = ${expectedDecrement.toString()}; a raw-amount scheme ` +
        `would have used debtToCover ${debtToCover.toString()} / ${CEILING_DIVISOR.toString()} = ` +
        `${rawDecrement.toString()}.`
    );

    // floor-on-burn under-shoots the requested raw amount at a residue boundary,
    // so the realized burn is <= the raw debtToCover: a concrete divergence.
    expect(realizedBurned).to.be.lte(debtToCover);
  });

  it('liquidationCall reverts HEALTH_FACTOR_NOT_BELOW_THRESHOLD on a healthy isolated position (guards (liq) non-vacuity)', async function () {
    this.timeout(240_000);
    const {
      users: [, borrower, , , liquidator],
      pool,
      usdc,
      aave,
    } = testEnv;
    const { HEALTH_FACTOR_NOT_BELOW_THRESHOLD } = ProtocolErrors;

    await driftUsdcIndexAboveRay();
    await postIsolatedCollateral(
      borrower.signer,
      borrower.address,
      await convertToCurrencyDecimals(aave.address, '20000')
    );

    // Small borrow => position stays healthy.
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(
          usdc.address,
          await convertToCurrencyDecimals(usdc.address, '100'),
          RateMode.Variable,
          '0',
          borrower.address
        )
    );

    // Non-vacuity sanity: the borrow itself moved the isolation counter.
    expect(await isoTotalDebt()).to.be.gt(0);

    await usdc
      .connect(liquidator.signer)
      ['mint(address,uint256)'](
        liquidator.address,
        await convertToCurrencyDecimals(usdc.address, '1000')
      );
    await usdc.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT);

    await expect(
      pool
        .connect(liquidator.signer)
        .liquidationCall(
          aave.address,
          usdc.address,
          borrower.address,
          await convertToCurrencyDecimals(usdc.address, '10'),
          false
        )
    ).to.be.revertedWith(HEALTH_FACTOR_NOT_BELOW_THRESHOLD);
  });
});
