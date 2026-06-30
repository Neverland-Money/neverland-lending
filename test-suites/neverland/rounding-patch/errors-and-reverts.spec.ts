/*
 * Neverland rounding patch: clearer validation errors (audit finding #23).
 *
 *  - Supplying / withdrawing to the aToken itself reverts SUPPLY_TO_ATOKEN (was the misleading
 *    INVALID_AMOUNT).
 *  - transferFrom above the approved allowance, and a delegated borrow above the delegated
 *    allowance, revert INSUFFICIENT_ALLOWANCE instead of a bare arithmetic panic.
 *
 * The allowance gates keep the exact same revert condition as the prior `x - amount` underflow;
 * only the surfaced error changes from Panic(0x11) to a named protocol error.
 *
 * VARIABLE RATE ONLY.
 */

import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';

import { MAX_UINT_AMOUNT } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

makeSuite('Neverland rounding patch: clearer validation errors', (testEnv: TestEnv) => {
  let snap: string;

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  it('supply onBehalfOf the aToken reverts SUPPLY_TO_ATOKEN', async () => {
    const {
      pool,
      dai,
      aDai,
      users: [supplier],
    } = testEnv;
    const amount = await convertToCurrencyDecimals(dai.address, '100');
    await waitForTx(await dai.connect(supplier.signer)['mint(uint256)'](amount));
    await waitForTx(await dai.connect(supplier.signer).approve(pool.address, amount));

    await expect(
      pool.connect(supplier.signer).supply(dai.address, amount, aDai.address, '0')
    ).to.be.revertedWith(ProtocolErrors.SUPPLY_TO_ATOKEN);
  });

  it('withdraw to the aToken reverts WITHDRAW_TO_ATOKEN', async () => {
    const {
      pool,
      dai,
      aDai,
      users: [supplier],
    } = testEnv;
    const amount = await convertToCurrencyDecimals(dai.address, '100');
    await waitForTx(await dai.connect(supplier.signer)['mint(uint256)'](amount));
    await waitForTx(await dai.connect(supplier.signer).approve(pool.address, amount));
    await waitForTx(
      await pool.connect(supplier.signer).supply(dai.address, amount, supplier.address, '0')
    );

    await expect(
      pool.connect(supplier.signer).withdraw(dai.address, amount, aDai.address)
    ).to.be.revertedWith(ProtocolErrors.WITHDRAW_TO_ATOKEN);
  });

  it('transferFrom above the approved allowance reverts INSUFFICIENT_ALLOWANCE', async () => {
    const {
      pool,
      dai,
      aDai,
      users: [owner, spender, recipient],
    } = testEnv;
    const supplyAmount = await convertToCurrencyDecimals(dai.address, '1000');
    await waitForTx(await dai.connect(owner.signer)['mint(uint256)'](supplyAmount));
    await waitForTx(await dai.connect(owner.signer).approve(pool.address, supplyAmount));
    await waitForTx(
      await pool.connect(owner.signer).supply(dai.address, supplyAmount, owner.address, '0')
    );

    const approved = await convertToCurrencyDecimals(dai.address, '100');
    const overAmount = await convertToCurrencyDecimals(dai.address, '101');
    await waitForTx(await aDai.connect(owner.signer).approve(spender.address, approved));

    await expect(
      aDai.connect(spender.signer).transferFrom(owner.address, recipient.address, overAmount)
    ).to.be.revertedWith(ProtocolErrors.INSUFFICIENT_ALLOWANCE);
  });

  it('a delegated borrow above the delegated allowance reverts INSUFFICIENT_ALLOWANCE', async () => {
    const {
      pool,
      dai,
      weth,
      variableDebtDai,
      users: [depositor, delegatee, delegator],
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '100');
    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0')
    );
    await waitForTx(
      await weth
        .connect(delegator.signer)
        ['mint(address,uint256)'](delegator.address, wethCollateral)
    );
    await waitForTx(await weth.connect(delegator.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(delegator.signer)
        .supply(weth.address, wethCollateral, delegator.address, '0')
    );

    const allowance = await convertToCurrencyDecimals(dai.address, '300');
    const overAmount = await convertToCurrencyDecimals(dai.address, '301');
    await waitForTx(
      await variableDebtDai
        .connect(delegator.signer)
        .approveDelegation(delegatee.address, allowance)
    );

    await expect(
      pool
        .connect(delegatee.signer)
        .borrow(dai.address, overAmount, RateMode.Variable, '0', delegator.address)
    ).to.be.revertedWith(ProtocolErrors.INSUFFICIENT_ALLOWANCE);
  });
});
