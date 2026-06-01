/*
 * Neverland rounding patch: supply / withdraw economics on the REAL Pool.
 *
 * End-to-end economic coverage the sibling specs lack: the patched
 * ATokenPEV3 + SupplyLogic / ValidationLogic leaf are driven through the
 * public Pool entrypoints (supply / withdraw / transfer) against the
 * makeSuite fixture's live DAI / WETH reserves.
 *
 * Behaviors mirrored (re-expressed on makeSuite, VARIABLE RATE ONLY) from the
 * neverland-lending-pool source specs:
 *   - tests/rounding/02-supply-withdraw-no-extraction.spec.ts
 *       multi-iteration supply/withdraw round-trip nets <= 0 base units to the
 *       user (no precision extraction).
 *   - tests/rounding/pool-supply-withdraw.spec.ts
 *       [2]  supply 0 -> INVALID_AMOUNT
 *       [3]  supply 1 wei at index > 2*RAY -> INVALID_AMOUNT (R10 upfront)
 *       [5]/[7] withdraw(MAX) zeroes scaled and transfers rayMulFloor(scaled, idx)
 *       [9]  withdraw > balance -> NOT_ENOUGH_AVAILABLE_USER_BALANCE
 *       [12b] supply-cap projection rejects over-cap scaled supply
 *       [13] R17: partial withdraw draining scaled to 0 auto-clears the flag
 *       [14] R17: partial transfer draining scaled to 0 auto-clears the flag
 *
 * Each `it` asserts a positive observable effect (a strictly-changed balance,
 * a counter == K, an index > RAY, a drained scaled balance) so a silent
 * early-revert cannot pass.
 */

import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { MAX_UINT_AMOUNT } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

const RAY = BigNumber.from(10).pow(27);
const HALF_RAY = RAY.div(2);

// Directional ray oracles (patched-direction floor; HALF-UP only as the
// exploit-finder baseline). See KIT.md "Inline directional oracles".
const rayMulFloor = (a: BigNumber, b: BigNumber) => a.mul(b).div(RAY);
const rayDivFloor = (a: BigNumber, b: BigNumber) => a.mul(RAY).div(b);
const rayDivCeil = (a: BigNumber, b: BigNumber) => {
  const n = a.mul(RAY);
  const q = n.div(b);
  return n.mod(b).isZero() ? q : q.add(1);
};
const rayMulHalfUp = (a: BigNumber, b: BigNumber) => a.mul(b).add(HALF_RAY).div(RAY);
const rayDivHalfUp = (a: BigNumber, b: BigNumber) => a.mul(RAY).add(b.div(2)).div(b);

// Smallest n that BOTH (a) historically extracts under half-up rounding
// (rayMulHalfUp(rayDivHalfUp(n, idx), idx) > n, the v3.0.2 extraction shape the
// patched stack must NOT pay back) AND (b) is still suppliable on the patched
// Pool now (rayDivFloor(n, idx) >= 1, so the R10 upfront scaled-amount check
// passes). The suppliability clause is required because at a drifted index a
// tiny n floors to 0 scaled and the patched SupplyLogic correctly rejects it
// (INVALID_AMOUNT); such an n is not a usable round-trip probe. Scan bound is
// generous so a moderate index (a few ulps above RAY) still yields a probe.
const findExploitInput = (index: BigNumber): BigNumber => {
  for (let i = 1; i < 4096; i++) {
    const n = BigNumber.from(i);
    const suppliable = rayDivFloor(n, index).gte(1);
    const historicallyExtracts = rayMulHalfUp(rayDivHalfUp(n, index), index).gt(n);
    if (suppliable && historicallyExtracts) {
      return n;
    }
  }
  throw new Error(
    `findExploitInput: no n < 4096 base units is both suppliable (rayDivFloor>=1) and historically extracting at index ${index.toString()}; re-tune the index drift`
  );
};

makeSuite('Neverland rounding patch: supply / withdraw economics', (testEnv: TestEnv) => {
  let snap: string;

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  /**
   * Drives utilization on the DAI reserve (a borrower posts WETH collateral
   * and draws DAI), then advances time so the liquidity index drifts above
   * RAY. Returns the live normalized income. The caller chooses how hard to
   * push (borrow fraction + seconds) to clear RAY, 2*RAY, etc.
   *
   * `opts.freeze` (default false): after drifting, fully repay the borrow so
   * utilization (and thus the liquidity rate) drops to zero. The index keeps
   * its drifted value (it is monotonic) but STOPS GROWING, so a subsequent
   * getReserveNormalizedIncome read equals the index every later supply /
   * withdraw / transfer tx will use. Required by any test that pre-computes an
   * expected amount or a ceil-quantum probe from a read-before-the-tx index:
   * with the borrow left open, each mined block folds fresh interest into the
   * stored index and the tx uses a HIGHER index than the read, confounding the
   * comparison. See composed-residue.spec.ts driftDaiLiquidityIndex for the
   * same freeze rationale.
   */
  const driftDaiIndex = async (
    depositor: { signer: any; address: string },
    borrower: { signer: any; address: string },
    opts: { daiLiquidity: BigNumber; borrowFraction: number; seconds: number; freeze?: boolean }
  ): Promise<BigNumber> => {
    const { pool, dai, weth } = testEnv;

    const wethCollateral = await convertToCurrencyDecimals(weth.address, '1000');

    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](opts.daiLiquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(depositor.signer)
        .supply(dai.address, opts.daiLiquidity, depositor.address, '0')
    );

    await waitForTx(
      await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .supply(weth.address, wethCollateral, borrower.address, '0')
    );

    const borrowAmount = opts.daiLiquidity.mul(opts.borrowFraction).div(100);
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address)
    );

    await increaseTime(opts.seconds);

    if (opts.freeze) {
      // Repay the entire (principal + accrued) variable debt. With no debt the
      // utilization, and hence the DAI liquidity rate, is zero, so the index is
      // pinned: getReserveNormalizedIncome == reserve.liquidityIndex and stays
      // equal through every subsequent tx in the test.
      // The accrued debt after a long, high-utilization drift compounds to many
      // multiples of the original liquidity, so size the repay budget off the
      // ACTUAL outstanding debt rather than a fixed multiple of liquidity (a
      // 2*liquidity buffer cannot cover a 60-year, 99%-utilization debt). The
      // extra margin covers the few blocks of accrual during mint/approve/repay.
      const outstandingDebt = await testEnv.variableDebtDai.balanceOf(borrower.address);
      const repayBuffer = outstandingDebt.mul(2).add(opts.daiLiquidity);
      await waitForTx(await dai.connect(borrower.signer)['mint(uint256)'](repayBuffer));
      await waitForTx(await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
      await waitForTx(
        await pool
          .connect(borrower.signer)
          .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address)
      );
    }

    // getReserveNormalizedIncome returns the live index incl. pending accrual.
    // When frozen (opts.freeze) there is no pending accrual, so this equals the
    // stored liquidityIndex and the index each later tx uses.
    return pool.getReserveNormalizedIncome(dai.address);
  };

  // Collateral-bit reader: UserConfiguration packs one bit-pair per reserveId;
  // the collateral flag sits at bit (reserveId * 2 + 1).
  const collateralBit = async (user: string): Promise<number> => {
    const { pool, dai } = testEnv;
    const userConfig = await pool.getUserConfiguration(user);
    const reserveData = await pool.getReserveData(dai.address);
    const reserveId: number = reserveData.id;
    return BigNumber.from(userConfig.data)
      .shr(reserveId * 2 + 1)
      .and(1)
      .toNumber();
  };

  it('round-trips supply/withdraw over a multi-iteration loop without extracting base units (delta <= 0)', async () => {
    const {
      users: [depositor, borrower, attacker],
      pool,
      dai,
      aDai,
    } = testEnv;

    // Drift the DAI index ABOVE RAY but keep it MODEST (a few percent over
    // RAY) via ~1 year of real utilization. A modest index is required so the
    // smallest historical-extraction input is still SUPPLIABLE: at a wildly
    // drifted index (e.g. 90% utilization over 5 years) the tiny exploit n
    // floors to 0 scaled and the patched SupplyLogic correctly rejects it
    // (R10 INVALID_AMOUNT), which is the patch working but makes the
    // round-trip probe unsuppliable. borrowFraction 80 over 1 year mirrors the
    // withdraw(MAX) / supply-cap drifts below, which are known to clear RAY
    // without overshooting. The 1-wei (R10) and R17 tests keep their OWN, much
    // harder drifts (99% over 60 years) to reach idx > 2*RAY.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const idx = await driftDaiIndex(depositor, borrower, {
      daiLiquidity,
      borrowFraction: 80,
      seconds: 365 * 24 * 60 * 60,
    });
    expect(idx).to.be.gt(
      RAY,
      'fixture must drift the DAI liquidity index above RAY for a meaningful round-trip'
    );

    const exploitN = findExploitInput(idx);
    const K = 25;
    const budget = exploitN.mul(K + 1);
    await waitForTx(await dai.connect(attacker.signer)['mint(uint256)'](budget));
    await waitForTx(await dai.connect(attacker.signer).approve(pool.address, MAX_UINT_AMOUNT));

    const balanceBefore = await dai.balanceOf(attacker.address);
    let preIter = balanceBefore;
    let completed = 0;

    for (let i = 0; i < K; i++) {
      await waitForTx(
        await pool.connect(attacker.signer).supply(dai.address, exploitN, attacker.address, '0')
      );
      await waitForTx(
        await pool.connect(attacker.signer).withdraw(dai.address, MAX_UINT_AMOUNT, attacker.address)
      );

      const newBal = await dai.balanceOf(attacker.address);
      const delta = newBal.sub(preIter);
      // Patched stack: residue never lands in the user's favor.
      expect(delta.toNumber()).to.be.lte(
        0,
        `iteration ${i}: extracted ${delta.toString()} base units (expected <= 0)`
      );
      expect(delta.toNumber()).to.be.gte(
        -1,
        `iteration ${i}: per-iter loss exceeded 1 base unit (${delta.toString()})`
      );
      preIter = newBal;

      // aToken balance returns to 0 after withdraw(MAX).
      expect(await aDai.balanceOf(attacker.address)).to.equal(
        0,
        `iteration ${i}: residual aToken balance`
      );
      completed += 1;
    }

    // Non-vacuous: the full loop ran (a silent early-revert would leave
    // completed < K), and the cumulative net is non-positive for the user.
    expect(completed).to.equal(
      K,
      'every round-trip iteration must execute (guards against silent early revert)'
    );
    const totalDelta = (await dai.balanceOf(attacker.address)).sub(balanceBefore);
    expect(totalDelta.toNumber()).to.be.lte(0);
    expect(totalDelta.toNumber()).to.be.gte(
      -K,
      `cumulative loss must not exceed K=${K} base units (got ${totalDelta})`
    );
  });

  it('rejects supply of 0 with INVALID_AMOUNT', async () => {
    const {
      users: [, user],
      pool,
      dai,
      aDai,
    } = testEnv;

    // Non-vacuous baseline: a positive supply mints aTokens, so the reserve
    // is live and the revert below is a real amount-validation reject.
    const positive = await convertToCurrencyDecimals(dai.address, '10');
    await waitForTx(await dai.connect(user.signer)['mint(uint256)'](positive));
    await waitForTx(await dai.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(user.signer).supply(dai.address, positive, user.address, '0')
    );
    expect(await aDai.balanceOf(user.address)).to.be.gt(
      0,
      'control supply must mint a positive aToken balance'
    );

    await expect(
      pool.connect(user.signer).supply(dai.address, 0, user.address, '0')
    ).to.be.revertedWith(ProtocolErrors.INVALID_AMOUNT);
  });

  it('rejects supply of 1 wei once the liquidity index exceeds 2*RAY (R10 upfront validation)', async () => {
    const {
      users: [depositor, borrower, user],
      pool,
      dai,
    } = testEnv;

    // Push the DAI index above 2*RAY: near-full utilization at slope2 over a
    // multi-decade horizon. The exact horizon scales with the stableTwo
    // profile; assert the precondition rather than assuming it.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const idx = await driftDaiIndex(depositor, borrower, {
      daiLiquidity,
      borrowFraction: 99,
      seconds: 60 * 365 * 24 * 60 * 60,
    });
    expect(idx).to.be.gt(
      RAY.mul(2),
      `precondition: DAI liquidity index must exceed 2*RAY for the 1-wei residue check to be meaningful (got ${idx.toString()}). Re-tune borrowFraction/seconds if the rate profile changed.`
    );

    // 1 wei against idx > 2*RAY: rayDivFloor(1, idx) == 0 scaled.
    // ValidationLogic.validateSupply catches this upfront (R10) and reverts
    // INVALID_AMOUNT (validation), strictly stronger than the leaf
    // INVALID_MINT_AMOUNT it would have hit AFTER safeTransferFrom.
    expect(rayDivFloor(BigNumber.from(1), idx)).to.equal(
      0,
      'sanity: 1 wei floors to 0 scaled at this index'
    );

    await waitForTx(await dai.connect(user.signer)['mint(uint256)'](BigNumber.from(1)));
    await waitForTx(await dai.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await expect(
      pool.connect(user.signer).supply(dai.address, 1, user.address, '0')
    ).to.be.revertedWith(ProtocolErrors.INVALID_AMOUNT);
  });

  it('withdraw(MAX) zeroes the scaled balance and transfers rayMulFloor(scaled, idx)', async () => {
    const {
      users: [depositor, borrower, user],
      pool,
      dai,
      aDai,
    } = testEnv;

    // Drift the index so scaled != amount and the floor is observable.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const idx = await driftDaiIndex(depositor, borrower, {
      daiLiquidity,
      borrowFraction: 80,
      seconds: 365 * 24 * 60 * 60,
    });
    expect(idx).to.be.gt(RAY, 'index must drift above RAY so the floor transfer is non-trivial');

    // Awkward non-round amount so scaled carries a residue against the index.
    const supplyAmount = BigNumber.from('1337133713371337');
    await waitForTx(await dai.connect(user.signer)['mint(uint256)'](supplyAmount));
    await waitForTx(await dai.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(user.signer).supply(dai.address, supplyAmount, user.address, '0')
    );

    // Capture the scaled balance immediately before the withdraw. scaled is
    // interest-invariant (it does not change as the index drifts), so it is the
    // correct anchor for the floor oracle. The amount transferred is
    // rayMulFloor(scaled, idxAtWithdraw), where idxAtWithdraw is the index the
    // burn used, NOT a stale pre-tx snapshot.
    const scaledBefore = await aDai.scaledBalanceOf(user.address);
    expect(scaledBefore).to.be.gt(0, 'control supply must mint a positive scaled balance');

    const balBefore = await dai.balanceOf(user.address);
    await waitForTx(
      await pool.connect(user.signer).withdraw(dai.address, MAX_UINT_AMOUNT, user.address)
    );
    const balAfter = await dai.balanceOf(user.address);

    // executeWithdraw folds pending accrual into the STORED liquidityIndex via
    // reserve.updateState (ReserveLogic._updateIndexes writes
    // reserve.liquidityIndex = reserveCache.nextLiquidityIndex), and the leaf
    // burn uses that same nextLiquidityIndex. No block is mined after this
    // withdraw, so the post-withdraw STORED index is exactly the index the
    // burn used. Read it via getReserveData (NOT getReserveNormalizedIncome,
    // which would add pending accrual relative to a later read block).
    const idxAtWithdraw = (await pool.getReserveData(dai.address)).liquidityIndex;
    const expectedFloor = rayMulFloor(scaledBefore, idxAtWithdraw);

    // With the exact burn index the transfer must equal the floor oracle; allow
    // +/- 1 wei only for ulp safety in the off-chain rayMul reproduction.
    const transferred = balAfter.sub(balBefore);
    expect(transferred).to.be.gt(
      0,
      'withdraw(MAX) must transfer a strictly positive underlying amount'
    );
    const diff = transferred.sub(expectedFloor).abs();
    expect(diff.lte(1)).to.equal(
      true,
      `transferred=${transferred}, expectedFloor=${expectedFloor}, scaled=${scaledBefore}, idxAtWithdraw=${idxAtWithdraw}`
    );

    // Scaled drained to 0 and aToken balance gone.
    expect(await aDai.scaledBalanceOf(user.address)).to.equal(0);
    expect(await aDai.balanceOf(user.address)).to.equal(0);
  });

  it('rejects withdraw above the available balance with NOT_ENOUGH_AVAILABLE_USER_BALANCE', async () => {
    const {
      users: [, user],
      pool,
      dai,
      aDai,
    } = testEnv;

    const supplyAmount = await convertToCurrencyDecimals(dai.address, '100');
    await waitForTx(await dai.connect(user.signer)['mint(uint256)'](supplyAmount));
    await waitForTx(await dai.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(user.signer).supply(dai.address, supplyAmount, user.address, '0')
    );

    const aBal = await aDai.balanceOf(user.address);
    expect(aBal).to.be.gt(
      0,
      'control supply must mint a positive aToken balance before the over-withdraw'
    );

    // No borrower / no drift on this reserve, so utilization (and the liquidity
    // rate) is zero and the index is pinned at RAY: aBal is interest-invariant
    // and aBal+1 stays a true over-balance boundary at the tx-time index. Assert
    // index stillness so a future fixture change that introduces accrual can't
    // silently turn the boundary stale (userBalance_at_tx > aBal would make
    // aBal+1 a valid withdraw and vacuously skip the revert).
    expect((await pool.getReserveData(dai.address)).liquidityIndex).to.equal(
      RAY,
      'reserve must have zero utilization so the over-balance boundary aBal+1 is index-stable'
    );

    await expect(
      pool.connect(user.signer).withdraw(dai.address, aBal.add(1), user.address)
    ).to.be.revertedWith(ProtocolErrors.NOT_ENOUGH_AVAILABLE_USER_BALANCE);

    // Non-vacuous control: an exact-balance withdraw still succeeds and drains.
    await waitForTx(
      await pool.connect(user.signer).withdraw(dai.address, MAX_UINT_AMOUNT, user.address)
    );
    expect(await aDai.scaledBalanceOf(user.address)).to.equal(0);
  });

  it('rejects an over-cap supply via the supply-cap projection on scaled supply', async () => {
    const {
      users: [depositor, borrower, user],
      pool,
      configurator,
      poolAdmin,
      dai,
      aDai,
    } = testEnv;

    // Drift the index above RAY first so the cap projection works on the
    // scaled-supply * index quantity (not raw base units) and is meaningful.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const idx = await driftDaiIndex(depositor, borrower, {
      daiLiquidity,
      borrowFraction: 80,
      seconds: 365 * 24 * 60 * 60,
    });
    expect(idx).to.be.gt(
      RAY,
      'index must drift above RAY so the cap projects on scaled supply, not raw amount'
    );

    // After the depositor seeded 100k DAI, total supply already far exceeds a
    // small cap. setSupplyCap is denominated in WHOLE tokens; set it well
    // below the existing aggregate so any further supply is rejected.
    await waitForTx(await configurator.connect(poolAdmin.signer).setSupplyCap(dai.address, '1'));

    const extra = await convertToCurrencyDecimals(dai.address, '10');
    await waitForTx(await dai.connect(user.signer)['mint(uint256)'](extra));
    await waitForTx(await dai.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));

    // Non-vacuous control: aggregate supply is provably positive (the seed
    // minted aTokens), so the cap rejection is real, not a no-op.
    expect(await aDai.scaledBalanceOf(depositor.address)).to.be.gt(
      0,
      'seed supply must exist so the cap is binding'
    );

    await expect(
      pool.connect(user.signer).supply(dai.address, extra, user.address, '0')
    ).to.be.revertedWith(ProtocolErrors.SUPPLY_CAP_EXCEEDED);
  });

  it('R17: a partial withdraw that drains the scaled balance to 0 auto-clears the collateral flag', async () => {
    const {
      users: [depositor, borrower, user],
      pool,
      dai,
      aDai,
    } = testEnv;

    // Need idx > 2*RAY so the ceil quantum boundary
    //   ( floor((scaled-1)*idx), floor(scaled*idx) ]
    // spans >= 2 integers, leaving a strict-partial amount whose ceil-scaled
    // burn still equals the full scaled balance. freeze:true repays the borrow
    // so the index stops growing: the ceil-quantum probe below reads the index
    // before the withdraw tx, and the burn must scale `withdrawAmount` against
    // the SAME index for the probe to be valid (a higher tx-time index would
    // ceil to < scaledBalance and the drain would not fire).
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const idxDrift = await driftDaiIndex(depositor, borrower, {
      daiLiquidity,
      borrowFraction: 99,
      seconds: 60 * 365 * 24 * 60 * 60,
      freeze: true,
    });
    expect(idxDrift).to.be.gt(
      RAY.mul(2),
      `precondition: index must exceed 2*RAY so a strict-partial drain amount exists (got ${idxDrift.toString()})`
    );

    // Supply a small amount so the scaled residue boundary is reachable by a
    // small probe.
    const supplyAmount = await convertToCurrencyDecimals(dai.address, '0.01');
    await waitForTx(await dai.connect(user.signer)['mint(uint256)'](supplyAmount));
    await waitForTx(await dai.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(user.signer).supply(dai.address, supplyAmount, user.address, '0')
    );

    // First supply auto-set the collateral flag (DAI is a collateral asset).
    expect(await collateralBit(user.address)).to.equal(
      1,
      'first supply must auto-set the collateral flag'
    );

    const userBalance = await aDai.balanceOf(user.address);
    const scaledBalance = await aDai.scaledBalanceOf(user.address);
    expect(scaledBalance).to.be.gt(0, 'control supply must mint a positive scaled balance');
    const liveIdx = await pool.getReserveNormalizedIncome(dai.address);
    expect(liveIdx).to.be.gt(RAY);
    // The index is frozen (borrow repaid), so the live normalized income equals
    // the stored liquidityIndex the withdraw tx will use. Assert it: a non-zero
    // liquidity rate here would mean the probe's ceil-quantum oracle (liveIdx)
    // diverges from the burn index and the drain test would be confounded.
    expect(liveIdx).to.equal(
      (await pool.getReserveData(dai.address)).liquidityIndex,
      'index must be frozen so the ceil-quantum probe oracle equals the withdraw-tx index'
    );

    // Probe for a partial withdraw amount whose leaf ceil-scaled burn
    // (rayDivCeil) equals the full scaled balance: i.e. it drains scaled to 0
    // while amount < userBalance.
    let chosen: BigNumber | null = null;
    const lowerBound = scaledBalance.sub(1).mul(liveIdx).div(RAY);
    for (let probe = 1; probe <= 8192; probe++) {
      const cand = lowerBound.add(probe);
      if (cand.gte(userBalance)) break;
      if (rayDivCeil(cand, liveIdx).eq(scaledBalance)) {
        chosen = cand;
        break;
      }
    }
    if (chosen === null) {
      throw new Error(
        `R17 probe: no partial withdraw amount in ((scaledBalance-1)*idx, userBalance) ceiled to scaledBalance. idx=${liveIdx}, scaled=${scaledBalance}, userBalance=${userBalance}.`
      );
    }
    const withdrawAmount = chosen as BigNumber;
    expect(withdrawAmount).to.be.lt(
      userBalance,
      'the drain amount must be a strict partial (< userBalance)'
    );

    await waitForTx(
      await pool.connect(user.signer).withdraw(dai.address, withdrawAmount, user.address)
    );

    // The boundary case under test: scaled drained to 0 by a PARTIAL withdraw.
    expect(await aDai.scaledBalanceOf(user.address)).to.equal(
      0,
      'partial withdraw must drain the scaled balance to zero (the boundary case under test)'
    );

    // R17 ASSERTION: the collateral flag auto-cleared even though
    // withdrawAmount < userBalance. v3.0.2 cleared only on unscaled equality,
    // leaving a stale flag on a zero-balance reserve.
    expect(await collateralBit(user.address)).to.equal(
      0,
      `R17: collateral flag must auto-clear when the burn drains scaled to 0, even with partial withdrawAmount=${withdrawAmount} < userBalance=${userBalance}`
    );

    // Negative control: manual recovery on a zero-balance reserve still
    // reverts (UNDERLYING_BALANCE_ZERO), so R17's auto-clear is the only fix.
    await expect(
      pool.connect(user.signer).setUserUseReserveAsCollateral(dai.address, false)
    ).to.be.revertedWith(ProtocolErrors.UNDERLYING_BALANCE_ZERO);
  });

  it('R17: a partial transfer that drains the scaled balance to 0 auto-clears the from-side collateral flag', async () => {
    const {
      users: [depositor, borrower, sender, recipient],
      pool,
      dai,
      aDai,
    } = testEnv;

    // freeze:true repays the borrow so the index is pinned: the ceil-quantum
    // probe reads the index before the transfer, and the leaf transfer scales
    // `transferAmount` (getATokenTransferScaledAmount = rayDivCeil) against the
    // SAME index. Without the freeze, the transfer tx folds another block of
    // 99%-utilization interest, the burn ceils against a higher index, and the
    // drain to scaled 0 would not fire.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const idxDrift = await driftDaiIndex(depositor, borrower, {
      daiLiquidity,
      borrowFraction: 99,
      seconds: 60 * 365 * 24 * 60 * 60,
      freeze: true,
    });
    expect(idxDrift).to.be.gt(
      RAY.mul(2),
      `precondition: index must exceed 2*RAY so a strict-partial drain amount exists (got ${idxDrift.toString()})`
    );

    const supplyAmount = await convertToCurrencyDecimals(dai.address, '0.01');
    await waitForTx(await dai.connect(sender.signer)['mint(uint256)'](supplyAmount));
    await waitForTx(await dai.connect(sender.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(sender.signer).supply(dai.address, supplyAmount, sender.address, '0')
    );

    expect(await collateralBit(sender.address)).to.equal(
      1,
      'first supply must auto-set the sender collateral flag'
    );
    expect(await collateralBit(recipient.address)).to.equal(
      0,
      'recipient starts without a collateral flag'
    );

    const senderBalance = await aDai.balanceOf(sender.address);
    const scaledBalance = await aDai.scaledBalanceOf(sender.address);
    expect(scaledBalance).to.be.gt(0, 'control supply must mint a positive scaled balance');
    const liveIdx = await pool.getReserveNormalizedIncome(dai.address);
    expect(liveIdx).to.be.gt(RAY);
    // Frozen index (borrow repaid): live normalized income equals the stored
    // liquidityIndex the transfer tx will use, so the ceil-quantum probe oracle
    // matches the burn index.
    expect(liveIdx).to.equal(
      (await pool.getReserveData(dai.address)).liquidityIndex,
      'index must be frozen so the ceil-quantum probe oracle equals the transfer-tx index'
    );

    // Same ceil-quantum probe as the withdraw case: the leaf transfer scales
    // amount via rayDivCeil (getATokenTransferScaledAmount).
    let chosen: BigNumber | null = null;
    const lowerBound = scaledBalance.sub(1).mul(liveIdx).div(RAY);
    for (let probe = 1; probe <= 8192; probe++) {
      const cand = lowerBound.add(probe);
      if (cand.gte(senderBalance)) break;
      if (rayDivCeil(cand, liveIdx).eq(scaledBalance)) {
        chosen = cand;
        break;
      }
    }
    if (chosen === null) {
      throw new Error(
        `R17 transfer probe: no partial transfer amount ceiled to scaledBalance. idx=${liveIdx}, scaled=${scaledBalance}, senderBalance=${senderBalance}.`
      );
    }
    const transferAmount = chosen as BigNumber;
    expect(transferAmount).to.be.lt(
      senderBalance,
      'the drain amount must be a strict partial (< senderBalance)'
    );

    await waitForTx(await aDai.connect(sender.signer).transfer(recipient.address, transferAmount));

    // Sender scaled drained to 0 by a partial transfer.
    expect(await aDai.scaledBalanceOf(sender.address)).to.equal(
      0,
      "partial transfer must drain the sender's scaled balance to zero"
    );

    // R17: from-side collateral flag auto-cleared on the drain.
    expect(await collateralBit(sender.address)).to.equal(
      0,
      `R17: sender collateral flag must clear when transfer drains scaled to 0, even with transferAmount=${transferAmount} < senderBalance=${senderBalance}`
    );

    // The credited recipient gains the full scaled balance and its flag
    // auto-enables (the transfer moved a non-zero scaled position).
    expect(await aDai.scaledBalanceOf(recipient.address)).to.equal(
      scaledBalance,
      'recipient must receive the full scaled balance the sender held'
    );
    expect(await collateralBit(recipient.address)).to.equal(
      1,
      'recipient collateral flag must auto-enable when it receives a non-zero scaled balance'
    );
  });
});
