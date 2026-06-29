/*
 * Neverland rounding patch: end-to-end borrow / repay economics on the REAL Pool.
 *
 * This spec re-expresses the POOL-repo regression scenarios
 *   - tests/rounding/04-borrow-repay-no-extraction.spec.ts
 *   - tests/rounding/pool-borrow-repay.spec.ts
 * on the LENDING makeSuite harness (patched stack: real Pool + ATokenPEV3 +
 * VariableDebtTokenPEV2 + DAI/USDC/WETH reserves already listed by the fixture).
 *
 * VARIABLE RATE ONLY. Stable rate is disabled by the patch.
 *
 * Behaviours covered (all NON-VACUOUS: every `it` asserts a positive observable
 * effect — a counter == K, a balance that strictly changed, or an index > RAY —
 * so a silent early-revert cannot pass):
 *   - borrow then repay(MAX, Variable) leaves 0 debt and 0 scaled debt
 *   - multi-iteration borrow/repay: per-iter underlying delta stays in [-1, 0]
 *   - vToken.balanceOf == rayMulCeil(scaledBalanceOf, idx) (patched read-back)
 *   - borrow 0 -> INVALID_AMOUNT
 *   - borrow over borrow-cap -> BORROW_CAP_EXCEEDED
 *   - borrow over borrow-cap against existing (combined) scaled debt -> BORROW_CAP_EXCEEDED
 *   - insufficient collateral -> COLLATERAL_CANNOT_COVER_NEW_BORROW
 *   - HF below threshold after collateral price drop -> 35
 *   - full repay clears userConfig.isBorrowing for the reserve
 *   - repay 0 -> INVALID_AMOUNT
 *
 * DOMAIN NOTE: we drift the variable borrow index strictly above RAY (utilization
 * + 1y time) and assert it moved before relying on no-dust full-repay residue.
 */

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { MAX_UINT_AMOUNT } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

const RAY = BigNumber.from(10).pow(27);

// Patched directional helper: the read-back balance the patched VToken exposes
// is rayMulCeil(scaledBalance, index) (protocol-favouring rounding-up).
const rayMulCeil = (a: BigNumber, b: BigNumber): BigNumber => {
  const prod = a.mul(b);
  const q = prod.div(RAY);
  return prod.mod(RAY).isZero() ? q : q.add(1);
};

// isBorrowing flag for a reserve lives at bit (2 * reserveId) of userConfig.data.
const isBorrowingFlagSet = (cfgData: BigNumber, reserveId: number): boolean =>
  cfgData
    .shr(2 * reserveId)
    .and(1)
    .eq(1);

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

makeSuite('Neverland rounding patch: borrow/repay economics', (testEnv: TestEnv) => {
  let snap: string;

  beforeEach(async () => {
    snap = await evmSnapshot();
  });
  afterEach(async () => {
    await evmRevert(snap);
  });

  // Swap to the mutable fallback PriceOracle so per-test price drops take
  // effect; restore the AaveOracle afterwards (kit oracle-wiring idiom).
  before(async () => {
    const { addressesProvider, oracle } = testEnv;
    await waitForTx(await addressesProvider.setPriceOracle(oracle.address));
  });
  after(async () => {
    const { addressesProvider, aaveOracle } = testEnv;
    await waitForTx(await addressesProvider.setPriceOracle(aaveOracle.address));
  });

  // ---------------------------------------------------------------------------
  // Shared setup helper: depositor seeds DAI liquidity, borrower posts WETH
  // collateral, then borrows `borrowDai` DAI variable. Optionally drifts the
  // DAI variable borrow index above RAY (utilization + time) so accrual is live.
  // Returns useful handles + the reserve id of DAI.
  // ---------------------------------------------------------------------------
  async function setupBorrow(opts: {
    daiLiquidity?: string;
    wethCollateral?: string;
    borrowDai?: string;
    accrue?: boolean;
  }) {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(
      dai.address,
      opts.daiLiquidity ?? '100000'
    );
    const wethCollateral = await convertToCurrencyDecimals(
      weth.address,
      opts.wethCollateral ?? '100'
    );

    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');
    await pool.connect(borrower.signer).setUserUseReserveAsCollateral(weth.address, true);

    if (opts.borrowDai) {
      const borrowAmount = await convertToCurrencyDecimals(dai.address, opts.borrowDai);
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address);
    }

    if (opts.accrue) {
      await increaseTime(ONE_YEAR_SECONDS);
      // Touch reserve state so the live index materializes into a state-write
      // path on the subsequent calls (a tiny extra supply by the depositor).
      const dust = await convertToCurrencyDecimals(dai.address, '1');
      await dai.connect(depositor.signer)['mint(uint256)'](dust);
      await pool.connect(depositor.signer).supply(dai.address, dust, depositor.address, '0');
    }

    const reserveId: number = (await pool.getReserveData(dai.address)).id;
    return { depositor, borrower, reserveId };
  }

  // ---------------------------------------------------------------------------
  // 1. borrow then repay(MAX, Variable) leaves 0 debt and 0 scaled debt.
  //    Index must be > RAY before we rely on the no-dust full-repay residue.
  // ---------------------------------------------------------------------------
  it('full repay(MAX, Variable) after accrual clears debt and scaled debt to 0', async () => {
    const { pool, dai, variableDebtDai } = testEnv;
    const { borrower } = await setupBorrow({ borrowDai: '1000', accrue: true });

    // The index must have moved above RAY for the residue assertion to mean
    // something (otherwise scaled == raw and rounding never engages).
    const idx = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(idx).to.be.gt(RAY);

    const debtBefore = await variableDebtDai.balanceOf(borrower.address);
    expect(debtBefore).to.be.gt(0);

    // Fund a generous buffer for the accrued interest, then repay everything.
    const buffer = await convertToCurrencyDecimals(dai.address, '2000');
    await dai.connect(borrower.signer)['mint(uint256)'](buffer);
    await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);

    await pool
      .connect(borrower.signer)
      .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address);

    expect(await variableDebtDai.balanceOf(borrower.address)).to.eq(0);
    expect(await variableDebtDai.scaledBalanceOf(borrower.address)).to.eq(0);
  });

  // ---------------------------------------------------------------------------
  // 2. vToken.balanceOf == rayMulCeil(scaledBalanceOf, idx) after a borrow.
  //    Asserts the patched read-back direction (ceil) on a live position.
  // ---------------------------------------------------------------------------
  it('vToken.balanceOf == rayMulCeil(scaled, idx) on a live borrow position', async () => {
    const { pool, dai, variableDebtDai } = testEnv;
    const { borrower } = await setupBorrow({ borrowDai: '1000', accrue: true });

    const idx = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(idx).to.be.gt(RAY);

    const scaled = await variableDebtDai.scaledBalanceOf(borrower.address);
    const balance = await variableDebtDai.balanceOf(borrower.address);
    expect(scaled).to.be.gt(0);
    expect(balance).to.be.gt(0);
    // Patched read-back: balance is the ceil-rounded product of scaled and idx.
    expect(balance).to.eq(rayMulCeil(scaled, idx));
  });

  // ---------------------------------------------------------------------------
  // 3. multi-iteration borrow/repay loop: per-iter underlying delta in [-1, 0].
  //    Mirrors POOL test 04 / 16. Non-vacuous: K successful round-trips, each
  //    with debt == 0 after repay, and every per-iter delta bounded.
  // ---------------------------------------------------------------------------
  it('K-iteration borrow/repay: per-iter underlying delta stays in [-1, 0] and debt clears each iter', async () => {
    const { pool, dai, variableDebtDai } = testEnv;
    const { borrower } = await setupBorrow({ borrowDai: '5000', accrue: true });

    // Index drifted above RAY by the seed borrow + 1y; confirm it moved.
    const idxStart = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(idxStart).to.be.gt(RAY);

    // Repay the seed borrow first so each loop iteration starts from 0 debt.
    const buffer = await convertToCurrencyDecimals(dai.address, '10000');
    await dai.connect(borrower.signer)['mint(uint256)'](buffer);
    await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(borrower.signer)
      .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address);
    expect(await variableDebtDai.balanceOf(borrower.address)).to.eq(0);

    // Pin block timestamps to advance deterministically by 1s per tx so the
    // index drifts a little each iteration (matches POOL loop discipline).
    const startBlock = await ethers.provider.getBlock('latest');
    let nextTimestamp: number = startBlock.timestamp;
    const setNextTs = async () => {
      nextTimestamp += 1;
      await ethers.provider.send('evm_setNextBlockTimestamp', [nextTimestamp]);
    };

    // Per-iter borrow size: a small fixed odd base-unit amount so the
    // scaled <-> balance conversion exercises non-trivial rounding.
    const perIter = BigNumber.from(255);

    const K = 12;
    const balanceBefore = await dai.balanceOf(borrower.address);
    const perIterDeltas: BigNumber[] = [];
    let prev = balanceBefore;
    let successfulIterations = 0;

    for (let i = 0; i < K; i++) {
      await setNextTs();
      await waitForTx(
        await pool
          .connect(borrower.signer)
          .borrow(dai.address, perIter, RateMode.Variable, '0', borrower.address)
      );
      await setNextTs();
      await waitForTx(
        await pool
          .connect(borrower.signer)
          .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address)
      );

      const after = await dai.balanceOf(borrower.address);
      perIterDeltas.push(after.sub(prev));
      prev = after;
      successfulIterations += 1;

      // No-dust: debt fully cleared each round-trip.
      expect(await variableDebtDai.balanceOf(borrower.address)).to.eq(
        0,
        `iter ${i}: post-repay vToken dust`
      );
    }

    // Non-vacuous: all K iterations actually ran.
    expect(successfulIterations).to.eq(K);

    for (let i = 0; i < K; i++) {
      // No extraction: the round-trip never returns MORE than was put in.
      expect(perIterDeltas[i]).to.be.lte(0, `iter ${i}: extracted ${perIterDeltas[i].toString()}`);
      // Bounded overcharge: at most 1 base unit lost per iteration.
      expect(perIterDeltas[i]).to.be.gte(
        BigNumber.from(-1),
        `iter ${i}: overcharged ${perIterDeltas[i].mul(-1).toString()}`
      );
    }
    const cumulative = perIterDeltas.reduce((acc, d) => acc.add(d), BigNumber.from(0));
    expect(cumulative).to.be.gte(
      BigNumber.from(-K),
      `cumulative overcharge exceeded ${K}: ${cumulative.toString()}`
    );
  });

  // ---------------------------------------------------------------------------
  // 4. borrow 0 -> INVALID_AMOUNT.
  // ---------------------------------------------------------------------------
  it('borrow zero amount reverts INVALID_AMOUNT', async () => {
    const { pool, dai } = testEnv;
    const { borrower } = await setupBorrow({});

    await expect(
      pool.connect(borrower.signer).borrow(dai.address, 0, RateMode.Variable, '0', borrower.address)
    ).to.be.revertedWith(ProtocolErrors.INVALID_AMOUNT);
  });

  // ---------------------------------------------------------------------------
  // 5. borrow over borrow-cap -> BORROW_CAP_EXCEEDED.
  //    Cap set to 10 DAI units; borrow 20 units must revert.
  // ---------------------------------------------------------------------------
  it('borrow over borrow-cap reverts BORROW_CAP_EXCEEDED', async () => {
    const { pool, dai, configurator, poolAdmin } = testEnv;
    const { borrower } = await setupBorrow({});

    await waitForTx(await configurator.connect(poolAdmin.signer).setBorrowCap(dai.address, 10));

    const overCap = await convertToCurrencyDecimals(dai.address, '20');
    await expect(
      pool
        .connect(borrower.signer)
        .borrow(dai.address, overCap, RateMode.Variable, '0', borrower.address)
    ).to.be.revertedWith(ProtocolErrors.BORROW_CAP_EXCEEDED);
  });

  // ---------------------------------------------------------------------------
  // 6. borrow-cap validated against the COMBINED (existing + new) reserve debt.
  //    Borrower already holds debt under the cap; a second borrow that pushes
  //    the combined total over the cap must revert BORROW_CAP_EXCEEDED. The
  //    index is drifted above RAY first so the realized (ceil-aligned) debt the
  //    leaf mints is what the cap is measured against, not the raw amount.
  // ---------------------------------------------------------------------------
  it('borrow-cap rejects a repeat borrow when combined scaled debt exceeds the cap', async () => {
    const { pool, dai, variableDebtDai, configurator, poolAdmin } = testEnv;
    // Seed an existing 5-DAI debt then drift the index above RAY.
    const { borrower } = await setupBorrow({ borrowDai: '5', accrue: true });

    const idx = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(idx).to.be.gt(RAY);

    // Existing realized debt (ceil read-back) is > 0 and comfortably below an
    // 8-DAI cap (5 DAI principal plus < 1 DAI of accrued interest).
    const existingDebt = await variableDebtDai.balanceOf(borrower.address);
    expect(existingDebt).to.be.gt(0);

    // Cap = 8 DAI units. Existing realized debt ~5-6 DAI sits under it.
    await waitForTx(await configurator.connect(poolAdmin.signer).setBorrowCap(dai.address, 8));

    // A second borrow of 5 DAI pushes combined realized debt (~10-11 DAI) over
    // the 8-unit cap. The cap is enforced on combined reserve debt, so this must
    // revert even though the first borrow was accepted under the same cap.
    const secondBorrow = await convertToCurrencyDecimals(dai.address, '5');
    await expect(
      pool
        .connect(borrower.signer)
        .borrow(dai.address, secondBorrow, RateMode.Variable, '0', borrower.address)
    ).to.be.revertedWith(ProtocolErrors.BORROW_CAP_EXCEEDED);

    // Non-vacuous sanity: the existing debt is genuinely still outstanding and
    // a SMALL repeat borrow that keeps combined debt under the cap is accepted,
    // proving the revert above was the cap and not a blanket rejection.
    const tinyBorrow = await convertToCurrencyDecimals(dai.address, '1');
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, tinyBorrow, RateMode.Variable, '0', borrower.address)
    );
    expect(await variableDebtDai.balanceOf(borrower.address)).to.be.gt(existingDebt);
  });

  // ---------------------------------------------------------------------------
  // 7. insufficient collateral -> COLLATERAL_CANNOT_COVER_NEW_BORROW.
  //    Tiny WETH collateral, borrow far more DAI than its LTV can back.
  // ---------------------------------------------------------------------------
  it('borrow beyond LTV headroom reverts COLLATERAL_CANNOT_COVER_NEW_BORROW', async () => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
    } = testEnv;

    // Plenty of DAI liquidity to lend.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '1000000');
    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    // Tiny collateral: 0.001 WETH.
    const tinyCollateral = await convertToCurrencyDecimals(weth.address, '0.001');
    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, tinyCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, tinyCollateral, borrower.address, '0');
    await pool.connect(borrower.signer).setUserUseReserveAsCollateral(weth.address, true);

    // Way beyond the LTV the tiny collateral can support.
    const overLtv = await convertToCurrencyDecimals(dai.address, '100000');
    await expect(
      pool
        .connect(borrower.signer)
        .borrow(dai.address, overLtv, RateMode.Variable, '0', borrower.address)
    ).to.be.revertedWith(ProtocolErrors.COLLATERAL_CANNOT_COVER_NEW_BORROW);
  });

  // ---------------------------------------------------------------------------
  // 8. HF below threshold after collateral price drop -> 35.
  //    Borrow near LTV, drop the WETH price so HF < 1, then any further borrow
  //    reverts HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD.
  // ---------------------------------------------------------------------------
  it('borrow after a collateral price drop reverts HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD', async () => {
    const { pool, dai, weth, oracle } = testEnv;
    // Borrower posts WETH and borrows a meaningful chunk of DAI.
    const { borrower } = await setupBorrow({
      daiLiquidity: '1000000',
      wethCollateral: '10',
      borrowDai: '5000',
    });

    // Confirm the position is healthy to start (non-vacuous precondition).
    const before = await pool.getUserAccountData(borrower.address);
    expect(before.healthFactor).to.be.gt(BigNumber.from(10).pow(18));
    expect(before.totalDebtBase).to.be.gt(0);

    // Crash the WETH collateral price to drive HF below 1.
    const wethPrice = await oracle.getAssetPrice(weth.address);
    await waitForTx(await oracle.setAssetPrice(weth.address, wethPrice.div(100)));

    const after = await pool.getUserAccountData(borrower.address);
    expect(after.healthFactor).to.be.lt(BigNumber.from(10).pow(18));

    // A further borrow now reverts with HF below liquidation threshold.
    const tinyBorrow = await convertToCurrencyDecimals(dai.address, '1');
    await expect(
      pool
        .connect(borrower.signer)
        .borrow(dai.address, tinyBorrow, RateMode.Variable, '0', borrower.address)
    ).to.be.revertedWith(ProtocolErrors.HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD);
  });

  // ---------------------------------------------------------------------------
  // 9. full repay clears userConfig.isBorrowing for the reserve.
  // ---------------------------------------------------------------------------
  it('full repay(MAX) clears userConfig.isBorrowing for the reserve', async () => {
    const { pool, dai, variableDebtDai } = testEnv;
    const { borrower, reserveId } = await setupBorrow({ borrowDai: '1000', accrue: true });

    const idx = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(idx).to.be.gt(RAY);

    // The borrowing flag is set while debt is outstanding.
    const cfgBefore: BigNumber = (await pool.getUserConfiguration(borrower.address)).data;
    expect(isBorrowingFlagSet(cfgBefore, reserveId)).to.eq(true);
    expect(await variableDebtDai.balanceOf(borrower.address)).to.be.gt(0);

    // Fund a buffer and fully repay.
    const buffer = await convertToCurrencyDecimals(dai.address, '2000');
    await dai.connect(borrower.signer)['mint(uint256)'](buffer);
    await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(borrower.signer)
      .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address);

    // Flag cleared and debt is zero.
    const cfgAfter: BigNumber = (await pool.getUserConfiguration(borrower.address)).data;
    expect(isBorrowingFlagSet(cfgAfter, reserveId)).to.eq(false);
    expect(await variableDebtDai.balanceOf(borrower.address)).to.eq(0);
  });

  // ---------------------------------------------------------------------------
  // 10. repay 0 -> INVALID_AMOUNT. The borrower must hold debt first so the
  //     validation reaches the amount==0 check (not NO_DEBT_OF_SELECTED_TYPE).
  // ---------------------------------------------------------------------------
  it('repay zero amount reverts INVALID_AMOUNT', async () => {
    const { pool, dai, variableDebtDai } = testEnv;
    const { borrower } = await setupBorrow({ borrowDai: '100' });

    // Non-vacuous precondition: there is outstanding debt to repay.
    expect(await variableDebtDai.balanceOf(borrower.address)).to.be.gt(0);

    await expect(
      pool.connect(borrower.signer).repay(dai.address, 0, RateMode.Variable, borrower.address)
    ).to.be.revertedWith(ProtocolErrors.INVALID_AMOUNT);
  });
});
