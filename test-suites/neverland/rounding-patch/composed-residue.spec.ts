/*
 * Composed-residue cross-account extraction defense (LENDING harness port).
 *
 * Ported from the POOL spec
 *   tests/rounding/composed-residue-transfer-withdraw.spec.ts
 * onto the makeSuite real-Pool fixture (patched ATokenPEV3 /
 * VariableDebtTokenPEV2 already wired into the DAI/WETH reserves),
 * variable-rate only.
 *
 * Attacker model: two colluding accounts (alice, bob) each supply DAI,
 * then drive a chain of residue-shaped aToken transfers between each
 * other at a non-trivial liquidity index (idx > RAY), and finally both
 * call withdraw(MAX). The patched ATokenPEV3._transfer routes the
 * scaled amount through rayDivCeil, so any residue accretes against the
 * SENDER (the protocol-favorable direction). A regression to floor or
 * half-up rounding could let the round-trip net positive scaled balance
 * to the receiver and let the pair extract more underlying than they
 * deposited.
 *
 * Conserved-value invariant (asserted across BOTH accounts, not just
 * one): the sum of underlying received by alice + bob via the dual
 * withdraw(MAX) exit MUST NOT exceed the sum of underlying they
 * supplied in. Equality is allowed (no rounding loss); the
 * protocol-favorable case is strict `<`.
 *
 * Non-vacuity: we (a) assert the liquidity index actually moved above
 * RAY before relying on residue behavior, (b) assert that at least one
 * residue-boundary transfer / transferFrom actually executed (counters
 * >= 1, and an `exercisedResidueBoundary` flag == true), and (c) assert
 * a strictly-positive observable balance change (attackers hold a
 * non-zero aToken balance before the exit, zero scaled balance after).
 * A silent early revert cannot satisfy these.
 */

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { evmSnapshot, evmRevert, increaseTime, waitForTx } from '@aave/deploy-v3';
import { MAX_UINT_AMOUNT } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

const RAY = BigNumber.from(10).pow(27);

// Inline directional oracles for the patched transfer leaf. The aToken
// transfer scaled-amount is rayDivCeil(amount, index) in the patched
// stack; rayDivFloor is the legacy (extraction-favorable) direction. We
// use the gap between them to *pick* residue-shaped transfer amounts.
const rayDivFloor = (amount: BigNumber, index: BigNumber): BigNumber => amount.mul(RAY).div(index);

const rayDivCeil = (amount: BigNumber, index: BigNumber): BigNumber => {
  const numerator = amount.mul(RAY);
  return numerator.isZero() ? BigNumber.from(0) : numerator.add(index).sub(1).div(index);
};

// Choose a transfer amount inside `balance` that lands on a non-zero
// rayDiv residue boundary (ceil > floor), so the transfer actually
// exercises the patched rounding direction. Clamped to >= 1 to avoid
// the INVALID_AMOUNT path.
const chooseResidueAmount = (
  balance: BigNumber,
  divisor: number,
  index: BigNumber,
  label: string
): BigNumber => {
  let amount = balance.div(divisor);
  if (amount.lt(1)) amount = BigNumber.from(1);
  for (let i = 0; i < 64 && amount.lte(balance); i++) {
    if (rayDivCeil(amount, index).gt(rayDivFloor(amount, index))) {
      return amount;
    }
    amount = amount.add(1);
  }
  throw new Error(`${label}: could not find residue transfer amount`);
};

const expectResidueBoundary = (amount: BigNumber, index: BigNumber, label: string) => {
  expect(
    rayDivCeil(amount, index).gt(rayDivFloor(amount, index)),
    `${label}: amount must exercise a non-zero rayDiv residue boundary`
  ).to.equal(true);
};

makeSuite(
  'Neverland rounding patch: composed-residue cross-account extraction',
  (testEnv: TestEnv) => {
    let snapId: string;

    beforeEach(async () => {
      snapId = await evmSnapshot();
    });

    afterEach(async () => {
      await evmRevert(snapId);
    });

    // Seed a deep DAI liquidity pool from an independent supplier, post
    // WETH collateral and borrow DAI variable, then let a year pass so
    // the DAI liquidity index drifts above RAY. Returns the live
    // normalized income (the index attackers will transfer against).
    const driftDaiLiquidityIndex = async (): Promise<BigNumber> => {
      const {
        users: [, , , liquidityProvider, borrower],
        pool,
        dai,
        weth,
      } = testEnv;

      const daiLiquidity = await convertToCurrencyDecimals(dai.address, '1000000');
      const wethCollateral = await convertToCurrencyDecimals(weth.address, '500');
      const daiToBorrow = await convertToCurrencyDecimals(dai.address, '500000');

      await dai.connect(liquidityProvider.signer)['mint(uint256)'](daiLiquidity);
      await dai.connect(liquidityProvider.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(liquidityProvider.signer)
        .supply(dai.address, daiLiquidity, liquidityProvider.address, '0');

      await weth
        .connect(borrower.signer)
        ['mint(address,uint256)'](borrower.address, wethCollateral);
      await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(borrower.signer)
        .supply(weth.address, wethCollateral, borrower.address, '0');
      await pool.connect(borrower.signer).setUserUseReserveAsCollateral(weth.address, true);
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, daiToBorrow, RateMode.Variable, '0', borrower.address);

      // Utilization + time lifts the DAI liquidity index well above RAY.
      await increaseTime(365 * 24 * 60 * 60);

      // Freeze the index: fully repay the borrow so utilization (and thus
      // the liquidity rate) drops to zero. The index stays at its drifted
      // value (it is monotonic) but stops growing. This is deliberate: it
      // isolates the COMPOSED-ROUNDING invariant from legitimate supplier
      // interest. If the index kept growing during the attack window,
      // alice/bob would earn real yield and `totalReceived <= deposit`
      // would (correctly) fail on interest rather than on rounding, which
      // is not the property under test. With the index frozen, any excess
      // over the deposit can only come from a rounding regression.
      const repayBuffer = await convertToCurrencyDecimals(dai.address, '1000000');
      await dai.connect(borrower.signer)['mint(uint256)'](repayBuffer);
      await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(borrower.signer)
        .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address);

      return pool.getReserveNormalizedIncome(dai.address);
    };

    it('transfer chain across two attacker accounts cannot extract underlying via residue + dual withdraw(MAX)', async () => {
      const {
        users: [alice, bob],
        pool,
        dai,
        aDai,
      } = testEnv;

      const idxBeforeAttack = await driftDaiLiquidityIndex();
      // Non-vacuity guard: index must have actually moved above RAY,
      // otherwise rayDivCeil == rayDivFloor and there is no residue to
      // defend against.
      expect(idxBeforeAttack).to.be.gt(RAY);

      // Alice supplies a deliberately non-round DAI amount so the scaled
      // balance carries a non-zero residue against the live index,
      // maximising the residue surface a transfer chain can probe.
      const aliceDeposit = await convertToCurrencyDecimals(dai.address, '1337');
      await dai.connect(alice.signer)['mint(uint256)'](aliceDeposit);
      await dai.connect(alice.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool.connect(alice.signer).supply(dai.address, aliceDeposit, alice.address, '0');

      const aliceUnderlyingBefore = await dai.balanceOf(alice.address);
      const bobUnderlyingBefore = await dai.balanceOf(bob.address);
      expect(aliceUnderlyingBefore).to.eq(0);
      expect(bobUnderlyingBefore).to.eq(0);

      // Non-vacuity: alice must actually hold a positive aToken balance
      // entering the attack loop.
      expect(await aDai.balanceOf(alice.address)).to.be.gt(0);

      // K residue-shaped transfer rounds: alice -> bob, then bob -> alice.
      const K = 8;
      let exercisedResidueBoundary = false;
      let executedTransferCount = 0;
      for (let i = 0; i < K; i++) {
        const aliceAToken = await aDai.balanceOf(alice.address);
        const aliceIndex = await pool.getReserveNormalizedIncome(dai.address);
        const transferAmount = chooseResidueAmount(aliceAToken, 3, aliceIndex, 'alice transfer');
        expectResidueBoundary(transferAmount, aliceIndex, 'alice transfer');
        exercisedResidueBoundary = true;
        if (transferAmount.gt(aliceAToken)) continue;
        await waitForTx(await aDai.connect(alice.signer).transfer(bob.address, transferAmount));
        executedTransferCount++;

        const bobAToken = await aDai.balanceOf(bob.address);
        const bobIndex = await pool.getReserveNormalizedIncome(dai.address);
        const returnAmount = chooseResidueAmount(bobAToken, 2, bobIndex, 'bob return transfer');
        expectResidueBoundary(returnAmount, bobIndex, 'bob return transfer');
        if (returnAmount.gt(bobAToken)) continue;
        await waitForTx(await aDai.connect(bob.signer).transfer(alice.address, returnAmount));
        executedTransferCount++;
      }
      // Non-vacuity: the residue boundary was actually probed and real
      // transfers actually ran (a silent early revert would leave these
      // false / zero).
      expect(exercisedResidueBoundary).to.equal(true);
      expect(executedTransferCount).to.be.gte(
        2,
        `expected the residue transfer chain to execute at least one full round-trip (got ${executedTransferCount} legs)`
      );

      // Both attackers exit via withdraw(MAX). Bob first; the ordering
      // does not change the composed invariant (the alice-first ordering
      // is structurally identical and runs against a near-identical idx).
      const bobAToken = await aDai.balanceOf(bob.address);
      expect(bobAToken).to.be.gt(0, 'bob must hold a positive aToken balance before exit');
      await waitForTx(
        await pool.connect(bob.signer).withdraw(dai.address, MAX_UINT_AMOUNT, bob.address)
      );

      const aliceAToken = await aDai.balanceOf(alice.address);
      expect(aliceAToken).to.be.gt(0, 'alice must hold a positive aToken balance before exit');
      await waitForTx(
        await pool.connect(alice.signer).withdraw(dai.address, MAX_UINT_AMOUNT, alice.address)
      );

      const aliceUnderlyingAfter = await dai.balanceOf(alice.address);
      const bobUnderlyingAfter = await dai.balanceOf(bob.address);
      const totalReceived = aliceUnderlyingAfter
        .add(bobUnderlyingAfter)
        .sub(aliceUnderlyingBefore)
        .sub(bobUnderlyingBefore);

      // Non-vacuity: the exit actually returned underlying to the pair.
      expect(totalReceived).to.be.gt(
        0,
        'dual withdraw(MAX) must return a positive underlying amount'
      );

      // Conserved-value invariant across BOTH accounts: the pair cannot
      // end with more underlying than alice supplied.
      expect(totalReceived.lte(aliceDeposit)).to.equal(
        true,
        `composed residue transfer + dual withdraw(MAX): attackers received ${totalReceived.toString()} underlying after K=${K} rounds; deposited ${aliceDeposit.toString()}. Patched stack must keep totalReceived <= aliceDeposit (protocol-favorable direction).`
      );

      // Both scaled balances must be fully settled after withdraw(MAX).
      expect(await aDai.scaledBalanceOf(alice.address)).to.eq(0);
      expect(await aDai.scaledBalanceOf(bob.address)).to.eq(0);
    });

    it('transferFrom-driven chain across two attacker accounts cannot extract underlying', async () => {
      const {
        users: [alice, bob],
        pool,
        dai,
        aDai,
      } = testEnv;

      const idxBeforeAttack = await driftDaiLiquidityIndex();
      expect(idxBeforeAttack).to.be.gt(RAY);

      // Both attackers seed a small, non-round DAI supply so transferFrom
      // can move scaled balance in either direction without hitting a
      // zero-balance shortfall path. The conserved-value invariant is
      // asserted against the SUM of both deposits.
      const aliceDeposit = await convertToCurrencyDecimals(dai.address, '999.991');
      const bobDeposit = await convertToCurrencyDecimals(dai.address, '444.443');
      const totalDeposit = aliceDeposit.add(bobDeposit);

      await dai.connect(alice.signer)['mint(uint256)'](aliceDeposit);
      await dai.connect(alice.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool.connect(alice.signer).supply(dai.address, aliceDeposit, alice.address, '0');

      await dai.connect(bob.signer)['mint(uint256)'](bobDeposit);
      await dai.connect(bob.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool.connect(bob.signer).supply(dai.address, bobDeposit, bob.address, '0');

      const aliceUnderlyingBefore = await dai.balanceOf(alice.address);
      const bobUnderlyingBefore = await dai.balanceOf(bob.address);
      expect(aliceUnderlyingBefore).to.eq(0);
      expect(bobUnderlyingBefore).to.eq(0);

      expect(await aDai.balanceOf(alice.address)).to.be.gt(0);
      expect(await aDai.balanceOf(bob.address)).to.be.gt(0);

      // Bob approves alice as an unlimited spender so the allowance-cap
      // branch does not fire and we exercise the non-cap transferFrom
      // arithmetic across the chain.
      await waitForTx(await aDai.connect(bob.signer).approve(alice.address, MAX_UINT_AMOUNT));

      const K = 6;
      let exercisedResidueBoundary = false;
      let executedTransferFromCount = 0;
      let executedTransferCount = 0;
      for (let i = 0; i < K; i++) {
        const bobAToken = await aDai.balanceOf(bob.address);
        const pullIndex = await pool.getReserveNormalizedIncome(dai.address);
        const pullAmount = chooseResidueAmount(bobAToken, 4, pullIndex, 'transferFrom pull');
        expectResidueBoundary(pullAmount, pullIndex, 'transferFrom pull');
        exercisedResidueBoundary = true;
        if (pullAmount.gt(bobAToken)) continue;
        await waitForTx(
          await aDai.connect(alice.signer).transferFrom(bob.address, alice.address, pullAmount)
        );
        executedTransferFromCount++;

        const aliceAToken = await aDai.balanceOf(alice.address);
        const pushIndex = await pool.getReserveNormalizedIncome(dai.address);
        const pushAmount = chooseResidueAmount(aliceAToken, 5, pushIndex, 'transfer push');
        expectResidueBoundary(pushAmount, pushIndex, 'transfer push');
        if (pushAmount.gt(aliceAToken)) continue;
        await waitForTx(await aDai.connect(alice.signer).transfer(bob.address, pushAmount));
        executedTransferCount++;
      }
      expect(exercisedResidueBoundary).to.equal(true);
      expect(executedTransferFromCount).to.be.gte(
        1,
        `at least one transferFrom must execute (got ${executedTransferFromCount}); all-skipped indicates the patched transferFrom path was never exercised`
      );
      expect(executedTransferCount).to.be.gte(
        1,
        `at least one transfer must execute (got ${executedTransferCount}); all-skipped indicates the patched transfer path was never exercised`
      );

      // Both attackers exit via withdraw(MAX).
      const bobATokenFinal = await aDai.balanceOf(bob.address);
      expect(bobATokenFinal).to.be.gt(0, 'bob must hold a positive aToken balance before exit');
      await waitForTx(
        await pool.connect(bob.signer).withdraw(dai.address, MAX_UINT_AMOUNT, bob.address)
      );

      const aliceATokenFinal = await aDai.balanceOf(alice.address);
      expect(aliceATokenFinal).to.be.gt(0, 'alice must hold a positive aToken balance before exit');
      await waitForTx(
        await pool.connect(alice.signer).withdraw(dai.address, MAX_UINT_AMOUNT, alice.address)
      );

      const aliceUnderlyingAfter = await dai.balanceOf(alice.address);
      const bobUnderlyingAfter = await dai.balanceOf(bob.address);
      const totalReceived = aliceUnderlyingAfter
        .add(bobUnderlyingAfter)
        .sub(aliceUnderlyingBefore)
        .sub(bobUnderlyingBefore);

      expect(totalReceived).to.be.gt(
        0,
        'dual withdraw(MAX) must return a positive underlying amount'
      );

      // Conserved-value invariant under transferFrom: total underlying
      // received by the pair <= total they supplied. A regression to
      // floor / half-up in ATokenPEV3._transfer or the burn leaf would
      // let this sum exceed totalDeposit at idx > RAY.
      expect(totalReceived.lte(totalDeposit)).to.equal(
        true,
        `composed transferFrom + dual withdraw(MAX): attackers received ${totalReceived.toString()} > deposited ${totalDeposit.toString()} (alice=${aliceDeposit.toString()} + bob=${bobDeposit.toString()}). Patched stack must keep this monotonic in the protocol's favor.`
      );

      expect(await aDai.scaledBalanceOf(alice.address)).to.eq(0);
      expect(await aDai.scaledBalanceOf(bob.address)).to.eq(0);
    });
  }
);
