/*
 * repayWithATokens rounding / no-extraction regression on the PATCHED stack
 * (LENDING repo, real Pool via makeSuite, variable rate only).
 *
 * Mirrors the scenarios in the POOL repo's
 *   tests/rounding/07-repay-with-atoken-rounding.spec.ts
 * re-expressed on the makeSuite harness. repayWithATokens has NO onBehalfOf:
 * payer == msg.sender, so the borrower must hold the aToken collateral they
 * pay debt down with.
 *
 * The patched repayWithATokens path composes two leaf overrides:
 *  - VToken debt read uses rayMulCeil (ATokenPEV3 / VariableDebtTokenPEV2),
 *    so the user's debt is never understated.
 *  - The aToken burn uses rayDivCeil with a stored-scaled-balance cap, so the
 *    protocol never burns more scaled aToken than the user actually has and a
 *    full repay leaves no dust scaled debt (VariableDebtTokenPEV2 full-repay
 *    clamp).
 *
 * The existing repay-with-atokens.spec.ts already covers the zero-aToken
 * INVALID_AMOUNT revert; this file builds only the positive / rounding cases.
 *
 * Every it asserts a positive observable effect (index strictly above RAY,
 * a balance strictly changed, a Repay event amount, a counter == K) so a
 * silent early-revert cannot pass.
 */

import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { MAX_UINT_AMOUNT, oneEther } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import '../../helpers/utils/wadraymath';

const RAY = BigNumber.from(10).pow(27);
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

// Repay(reserve, user, repayer, amount, useATokens)
const REPAY_EVENT_SIG = utils.keccak256(
  utils.toUtf8Bytes('Repay(address,address,address,uint256,bool)')
);

// Inline directional oracles mirroring the patched leaf math
// (contracts/dependencies/helpers/TokenMath.sol + WadRayMath.sol). These are
// the interest-INVARIANT yardstick for the burns: the aToken burn scales the
// repaid amount by rayDivCeil (getATokenBurnScaledAmount) and the vToken burn
// scales it by rayDivFloor (getVTokenBurnScaledAmount). Scaled-balance deltas
// do not move with index accrual, so a +/- 1 wei tolerance is correct on them
// (unlike index-scaled balanceOf deltas, which absorb one block of interest).
const rayDivFloor = (amount: BigNumber, index: BigNumber): BigNumber => amount.mul(RAY).div(index);

const rayDivCeil = (amount: BigNumber, index: BigNumber): BigNumber => {
  const numerator = amount.mul(RAY);
  return numerator.isZero() ? BigNumber.from(0) : numerator.add(index).sub(1).div(index);
};

const getATokenBurnScaledAmount = (amount: BigNumber, liquidityIndex: BigNumber): BigNumber =>
  rayDivCeil(amount, liquidityIndex);

const getVTokenBurnScaledAmount = (amount: BigNumber, variableBorrowIndex: BigNumber): BigNumber =>
  rayDivFloor(amount, variableBorrowIndex);

// getVTokenBalance: the displayed debt is rayMulCeil(scaled, index) on the
// patched stack (debt is never understated). Used to reconstruct, interest-
// invariantly, the exact debt the leaf cleared at the repay block.
const rayMulCeil = (scaled: BigNumber, index: BigNumber): BigNumber => {
  const product = scaled.mul(index);
  return product.isZero() ? BigNumber.from(0) : product.sub(1).div(RAY).add(1);
};

makeSuite('Neverland rounding patch: repayWithATokens rounding', (testEnv: TestEnv) => {
  let snapId: string;

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  /**
   * Stand up a borrower with WETH collateral and a DAI variable-rate loan,
   * a depositor providing DAI liquidity, and (after time advances) DAI
   * indices strictly above RAY. The borrower then receives aDAI collateral
   * so they can pay debt down through repayWithATokens.
   */
  const setupBorrowerWithATokenCollateral = async (
    daiLiquidityHuman: string,
    wethCollateralHuman: string,
    borrowHuman: string
  ) => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, daiLiquidityHuman);
    const wethCollateral = await convertToCurrencyDecimals(weth.address, wethCollateralHuman);
    const borrowAmount = await convertToCurrencyDecimals(dai.address, borrowHuman);

    // Depositor seeds DAI liquidity and also keeps aDAI collateral that the
    // borrower can later acquire (depositor is the source of the aDAI the
    // borrower pays with). Depositor supplies double so they can later
    // transfer aDAI to the borrower.
    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity.mul(2)));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(depositor.signer)
        .supply(dai.address, daiLiquidity.mul(2), depositor.address, '0')
    );

    // Borrower posts WETH collateral and borrows DAI at variable rate.
    await waitForTx(
      await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
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

    return { depositor, borrower, daiLiquidity, wethCollateral, borrowAmount };
  };

  it('happy path: partial repayWithATokens strictly decreases both the borrower vToken debt and aToken balance', async () => {
    const { pool, dai, aDai, variableDebtDai } = testEnv;

    const { depositor, borrower, borrowAmount } = await setupBorrowerWithATokenCollateral(
      '10000',
      '20',
      '2000'
    );

    // Borrower acquires aDAI collateral to pay debt down with (no onBehalfOf,
    // so the payer must hold the aDAI). Give them enough to cover a partial
    // repay but not the whole loan.
    const aDaiTransfer = await convertToCurrencyDecimals(dai.address, '2500');
    await waitForTx(await aDai.connect(depositor.signer).transfer(borrower.address, aDaiTransfer));

    // Accrue interest: utilization already exists (borrower borrowed), so just
    // advance time and force a state-touch by reading via a fresh tx. Assert
    // the index strictly moved above RAY so the residue behavior is real.
    await increaseTime(ONE_YEAR_SECONDS);
    const liqIndex = await pool.getReserveNormalizedIncome(dai.address);
    const debtIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(liqIndex).to.be.gt(RAY);
    expect(debtIndex).to.be.gt(RAY);

    const repayAmount = await convertToCurrencyDecimals(dai.address, '1000');

    const aDaiBefore = await aDai.balanceOf(borrower.address);
    const debtBefore = await variableDebtDai.balanceOf(borrower.address);
    expect(aDaiBefore).to.be.gt(repayAmount);
    expect(debtBefore).to.be.gt(repayAmount);

    // Scaled balances are the interest-invariant ledger entries: the repay
    // burns a fixed scaled amount, while index accrual on the REMAINING balance
    // does not touch the scaled balance. Capture them right before the repay.
    const scaledBefore = await aDai.scaledBalanceOf(borrower.address);
    const vScaledBefore = await variableDebtDai.scaledBalanceOf(borrower.address);

    const tx = await waitForTx(
      await pool
        .connect(borrower.signer)
        .repayWithATokens(dai.address, repayAmount, RateMode.Variable)
    );

    const repayLog = tx.logs.find((log) => log.topics[0] === REPAY_EVENT_SIG);
    expect(repayLog, 'Repay event not emitted').to.not.be.undefined;
    const repayEvent = pool.interface.parseLog(repayLog!);
    expect(repayEvent.args.useATokens).to.be.true;
    expect(repayEvent.args.reserve).to.be.eq(dai.address);
    expect(repayEvent.args.user).to.be.eq(borrower.address);
    expect(repayEvent.args.repayer).to.be.eq(borrower.address);
    // Partial repay of an explicit amount: the protocol pays down exactly the
    // requested amount.
    expect(repayEvent.args.amount).to.be.eq(repayAmount);

    const aDaiAfter = await aDai.balanceOf(borrower.address);
    const debtAfter = await variableDebtDai.balanceOf(borrower.address);
    const scaledAfter = await aDai.scaledBalanceOf(borrower.address);
    const vScaledAfter = await variableDebtDai.scaledBalanceOf(borrower.address);

    // Read the live indexes at (just after) the repay block so the expected
    // scaled burns are computed against the same index the leaf used.
    const idxAtRepay = await pool.getReserveNormalizedIncome(dai.address);
    const debtIdxAtRepay = await pool.getReserveNormalizedVariableDebt(dai.address);

    // Both sides strictly decreased (non-vacuous).
    expect(aDaiAfter).to.be.lt(aDaiBefore);
    expect(debtAfter).to.be.lt(debtBefore);

    // PRECISE, interest-invariant check on the burns. The aToken burn scales
    // repayAmount via rayDivCeil and the vToken burn via rayDivFloor; the
    // scaled-balance deltas must equal those expected scaled amounts within
    // +/- 1 wei (the index read one block late shifts the boundary by at most
    // one ulp).
    const expectedAScaledBurn = getATokenBurnScaledAmount(repayAmount, idxAtRepay);
    const expectedVScaledBurn = getVTokenBurnScaledAmount(repayAmount, debtIdxAtRepay);
    expect(scaledBefore.sub(scaledAfter)).to.be.closeTo(expectedAScaledBurn, 1);
    expect(vScaledBefore.sub(vScaledAfter)).to.be.closeTo(expectedVScaledBurn, 1);

    // Human-facing balanceOf deltas pay down ~repayAmount on both sides. The
    // residual gap is one block of interest accrued on the borrower's REMAINING
    // aDai / debt between the read and the repay tx, NOT a rounding leak, so the
    // tolerance is relative (within 0.0001%) rather than a fixed +/- 2 wei.
    const balTol = repayAmount.div(1_000_000);
    expect(aDaiBefore.sub(aDaiAfter)).to.be.closeTo(repayAmount, balTol);
    expect(debtBefore.sub(debtAfter)).to.be.closeTo(repayAmount, balTol);

    // Debt remains positive: this was a partial repay, not a full clear.
    expect(debtAfter).to.be.gt(0);
  });

  it('over-balance repayWithATokens(MAX): Repay amount == aToken balance, aToken cleared to 0, residual debt remains, no dust beyond the balance', async () => {
    const { pool, dai, aDai, variableDebtDai } = testEnv;

    const { depositor, borrower } = await setupBorrowerWithATokenCollateral('10000', '20', '3000');

    // Borrower acquires LESS aDAI than their outstanding debt, so a MAX
    // repayWithATokens is clamped to the aToken balance (the over-balance
    // case from the upstream "User 1 receives 25 aDAI ... use all aDai to
    // repay debt" scenario).
    const aDaiTransfer = await convertToCurrencyDecimals(dai.address, '1000');
    await waitForTx(await aDai.connect(depositor.signer).transfer(borrower.address, aDaiTransfer));

    // Accrue interest so the aToken balance and debt are both index-scaled and
    // the ceil-burn direction is exercised on a non-RAY index.
    await increaseTime(ONE_YEAR_SECONDS);
    const liqIndex = await pool.getReserveNormalizedIncome(dai.address);
    const debtIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(liqIndex).to.be.gt(RAY);
    expect(debtIndex).to.be.gt(RAY);

    const aDaiBefore = await aDai.balanceOf(borrower.address);
    const debtBefore = await variableDebtDai.balanceOf(borrower.address);
    // Scaled aToken the borrower holds going in; the over-balance MAX consumes
    // ALL of it, so this is the interest-invariant anchor for the paid amount.
    const scaledBefore = await aDai.scaledBalanceOf(borrower.address);
    // Precondition for this case: debt strictly exceeds the aToken balance, so
    // MAX cannot clear the loan and must clamp to the aToken balance.
    expect(debtBefore).to.be.gt(aDaiBefore);
    expect(aDaiBefore).to.be.gt(0);

    const tx = await waitForTx(
      await pool
        .connect(borrower.signer)
        .repayWithATokens(dai.address, MAX_UINT_AMOUNT, RateMode.Variable)
    );

    // Live liquidity index at (just after) the repay block: the leaf clamped
    // the paid amount to the aToken balance evaluated against THIS index, which
    // is one block past the aDaiBefore read.
    const idxAtRepay = await pool.getReserveNormalizedIncome(dai.address);

    const repayLog = tx.logs.find((log) => log.topics[0] === REPAY_EVENT_SIG);
    expect(repayLog, 'Repay event not emitted').to.not.be.undefined;
    const repayEvent = pool.interface.parseLog(repayLog!);
    expect(repayEvent.args.useATokens).to.be.true;
    expect(repayEvent.args.user).to.be.eq(borrower.address);
    expect(repayEvent.args.repayer).to.be.eq(borrower.address);
    // Over-balance MAX: the paid amount is the borrower's ENTIRE aToken balance
    // (clamped to balance, not to debt). The precise, interest-invariant value
    // is getATokenBalance(scaledBefore, idxAtRepay) = rayMulFloor of the full
    // scaled balance at the repay index, i.e. exactly the aToken.balanceOf the
    // leaf read inside the repay tx (one block past the aDaiBefore read).
    const expectedPaid = scaledBefore.mul(idxAtRepay).div(RAY);
    expect(repayEvent.args.amount).to.be.closeTo(expectedPaid, 2);
    // It equals aDaiBefore plus one block of accrual: can only have grown,
    // never shrunk, relative to the (one block earlier) aDaiBefore read.
    expect(repayEvent.args.amount).to.be.gte(aDaiBefore);

    const aDaiAfter = await aDai.balanceOf(borrower.address);
    const debtAfter = await variableDebtDai.balanceOf(borrower.address);
    const scaledAfter = await aDai.scaledBalanceOf(borrower.address);

    // aToken fully consumed: balance and scaled balance both exactly 0 (no
    // dust collateral left behind, the ceil-burn cap snapped to the stored
    // scaled balance).
    expect(aDaiAfter).to.be.eq(0);
    expect(scaledAfter).to.be.eq(0);

    // Debt was reduced by ~the aToken balance and a residual remains (this is
    // an over-balance, not a full clear). Non-vacuous: debt strictly moved.
    expect(debtAfter).to.be.lt(debtBefore);
    expect(debtAfter).to.be.gt(0);
    // The debt delta tracks the paid amount (~the borrower's aToken balance);
    // the residual gap is one block of interest accrued on the REMAINING debt
    // between the read and the repay tx, NOT a rounding leak, so the tolerance
    // is relative (within 0.0001%) rather than a fixed +/- 2 wei.
    expect(debtBefore.sub(debtAfter)).to.be.closeTo(aDaiBefore, aDaiBefore.div(1_000_000));

    // R45-flavored guard: after ceil-burning the borrower's collateral while
    // debt remains, the position must still be solvent (HF stays above 1).
    // The WETH collateral comfortably backs the residual DAI debt, so the
    // operation did not push the borrower below the liquidation threshold.
    const account = await pool.getUserAccountData(borrower.address);
    expect(account.totalDebtBase).to.be.gt(0);
    expect(account.healthFactor).to.be.gt(oneEther);
  });

  it('full repayWithATokens(MAX): clears the vToken debt to exactly 0 with no scaled dust, Repay amount == debt cleared', async () => {
    const { pool, dai, aDai, variableDebtDai } = testEnv;

    const { depositor, borrower } = await setupBorrowerWithATokenCollateral('10000', '20', '2000');

    // Borrower acquires MORE aDAI than their debt, so a MAX repayWithATokens
    // clamps to the (smaller) debt and fully clears it (the upstream
    // "User 1 receives 55 aDAI ... repay all debt" scenario).
    const aDaiTransfer = await convertToCurrencyDecimals(dai.address, '4000');
    await waitForTx(await aDai.connect(depositor.signer).transfer(borrower.address, aDaiTransfer));

    // Accrue interest so the full-repay clamp on the VToken side is exercised
    // against a debt index strictly above RAY (otherwise dust cannot arise and
    // the assertion would be vacuous).
    await increaseTime(ONE_YEAR_SECONDS);
    const liqIndex = await pool.getReserveNormalizedIncome(dai.address);
    const debtIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(liqIndex).to.be.gt(RAY);
    expect(debtIndex).to.be.gt(RAY);

    const aDaiBefore = await aDai.balanceOf(borrower.address);
    const debtBefore = await variableDebtDai.balanceOf(borrower.address);
    // Scaled debt going in; the full clear burns ALL of it, so this is the
    // interest-invariant anchor for the paid (cleared) amount.
    const vScaledBefore = await variableDebtDai.scaledBalanceOf(borrower.address);
    // Precondition: aToken balance strictly exceeds the debt, so MAX clears
    // the whole loan and leaves leftover aToken collateral.
    expect(aDaiBefore).to.be.gt(debtBefore);
    expect(debtBefore).to.be.gt(0);

    const tx = await waitForTx(
      await pool
        .connect(borrower.signer)
        .repayWithATokens(dai.address, MAX_UINT_AMOUNT, RateMode.Variable)
    );

    // Live debt index at (just after) the repay block: the leaf read the full
    // debt against THIS index, one block past the debtBefore read.
    const debtIdxAtRepay = await pool.getReserveNormalizedVariableDebt(dai.address);

    const repayLog = tx.logs.find((log) => log.topics[0] === REPAY_EVENT_SIG);
    expect(repayLog, 'Repay event not emitted').to.not.be.undefined;
    const repayEvent = pool.interface.parseLog(repayLog!);
    expect(repayEvent.args.useATokens).to.be.true;
    expect(repayEvent.args.user).to.be.eq(borrower.address);
    expect(repayEvent.args.repayer).to.be.eq(borrower.address);
    // Full clear: paid amount equals the borrower's full variable debt at the
    // repay block = getVTokenBalance(vScaledBefore, debtIdxAtRepay) =
    // rayMulCeil(...). This is debtBefore plus one block of debt accrual, so it
    // can only have grown, never shrunk, relative to the debtBefore read.
    const expectedCleared = rayMulCeil(vScaledBefore, debtIdxAtRepay);
    expect(repayEvent.args.amount).to.be.closeTo(expectedCleared, 2);
    expect(repayEvent.args.amount).to.be.gte(debtBefore);

    const debtAfter = await variableDebtDai.balanceOf(borrower.address);
    const debtScaledAfter = await variableDebtDai.scaledBalanceOf(borrower.address);
    const aDaiAfter = await aDai.balanceOf(borrower.address);

    // No dust: both the displayed and the scaled variable debt are exactly 0
    // (the full-repay clamp snaps amountScaled to the stored scaled balance).
    expect(debtAfter).to.be.eq(0);
    expect(debtScaledAfter).to.be.eq(0);

    // Non-vacuous on the collateral side: the borrower's aToken strictly
    // decreased (they spent ~debtBefore of aDAI) but retains the surplus.
    expect(aDaiAfter).to.be.lt(aDaiBefore);
    expect(aDaiAfter).to.be.gt(0);
    // The collateral delta tracks the cleared debt (~debtBefore); the residual
    // gap is one block of interest accrued on the borrower's REMAINING aDai
    // surplus between the read and the repay tx, NOT a rounding leak, so the
    // tolerance is relative (within 0.0001%) rather than a fixed +/- 2 wei.
    expect(aDaiBefore.sub(aDaiAfter)).to.be.closeTo(debtBefore, debtBefore.div(1_000_000));
  });

  it('K-iteration borrow / repayWithATokens(MAX) loop: every iteration clears debt to 0 with no dust, scaled aToken never grows (no extraction)', async () => {
    const { pool, dai, aDai, variableDebtDai } = testEnv;

    const { depositor, borrower } = await setupBorrowerWithATokenCollateral('20000', '40', '1000');

    // Fund the borrower with a large aDAI stash so they can clear each
    // iteration's small re-borrow with their collateral.
    const aDaiTransfer = await convertToCurrencyDecimals(dai.address, '8000');
    await waitForTx(await aDai.connect(depositor.signer).transfer(borrower.address, aDaiTransfer));

    // Drift indices above RAY before the loop so the ceil-burn rounding is
    // exercised on a non-trivial index every iteration.
    await increaseTime(ONE_YEAR_SECONDS);
    const liqIndex = await pool.getReserveNormalizedIncome(dai.address);
    const debtIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(liqIndex).to.be.gt(RAY);
    expect(debtIndex).to.be.gt(RAY);

    // First, clear the existing loan with aTokens so each loop iteration
    // starts from zero debt.
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .repayWithATokens(dai.address, MAX_UINT_AMOUNT, RateMode.Variable)
    );
    expect(await variableDebtDai.balanceOf(borrower.address)).to.be.eq(0);

    const reborrow = await convertToCurrencyDecimals(dai.address, '37');
    const K = 12;

    const scaledATokenBefore = await aDai.scaledBalanceOf(borrower.address);
    let prevScaledAToken = scaledATokenBefore;
    let clears = 0;

    for (let i = 0; i < K; i++) {
      await waitForTx(
        await pool
          .connect(borrower.signer)
          .borrow(dai.address, reborrow, RateMode.Variable, '0', borrower.address)
      );
      // Each iteration accrues a little so the per-iter ceil-burn fires on a
      // moving index.
      await increaseTime(7 * 24 * 60 * 60);

      const debtPreRepay = await variableDebtDai.balanceOf(borrower.address);
      expect(debtPreRepay, `iteration ${i}: debt did not accrue`).to.be.gt(0);

      await waitForTx(
        await pool
          .connect(borrower.signer)
          .repayWithATokens(dai.address, MAX_UINT_AMOUNT, RateMode.Variable)
      );

      // Per-iter: full repay leaves no dust scaled debt.
      const debtAfter = await variableDebtDai.balanceOf(borrower.address);
      const debtScaledAfter = await variableDebtDai.scaledBalanceOf(borrower.address);
      expect(debtAfter, `iteration ${i}: vToken dust after full repayWithATokens`).to.be.eq(0);
      expect(debtScaledAfter, `iteration ${i}: scaled vToken dust`).to.be.eq(0);

      // Per-iter: scaled aToken collateral never grows. A burn strictly
      // decreases it; interest accrual does not change scaled balance. So the
      // protocol can never gift the borrower scaled aTokens through rounding.
      const scaledATokenAfter = await aDai.scaledBalanceOf(borrower.address);
      expect(
        scaledATokenAfter,
        `iteration ${i}: scaled aToken grew ${prevScaledAToken.toString()} -> ${scaledATokenAfter.toString()}`
      ).to.be.lte(prevScaledAToken);
      prevScaledAToken = scaledATokenAfter;
      clears += 1;
    }

    // Non-vacuous: the loop actually ran K times.
    expect(clears).to.be.eq(K);

    // Cumulative: scaled aToken strictly decreased across the loop (the burn
    // fired for non-zero scaled amounts K times) and never increased.
    const scaledATokenAfterAll = await aDai.scaledBalanceOf(borrower.address);
    expect(scaledATokenAfterAll).to.be.lt(scaledATokenBefore);
  });
});
