/*
 * Neverland security: flash-loan liquidity-index inflation -> later-supplier harvest.
 *
 * On the old LP-split code a flash loan moves the liquidity index via cumulateToLiquidityIndex. A
 * sole supplier can self-fund a flash barrage to inflate the index to an arbitrary granularity G
 * (value per scaled unit). The inflation of the attacker's OWN position is break-even (they pay the
 * premium), which is why a naive analysis calls it harmless; the damage is to the NEXT supplier:
 * their credited shares are amountScaled = floor(V * RAY / index), so a deposit V that is not a
 * multiple of G loses (V mod G) to the floor, and that remainder accrues to the attacker's shares.
 * Deposits below G revert outright (a DoS). This is the empty-market share-inflation harvest, and the
 * flash index bump is what makes inflating G cheap.
 *
 * Routing the full premium to the treasury (no cumulateToLiquidityIndex) freezes the index against
 * any flash barrage, so G stays 1 and every later supplier is credited their exact deposit.
 *
 * VARIABLE RATE ONLY.
 */

import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { MAX_UINT_AMOUNT } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

declare var hre: HardhatRuntimeEnvironment;

const RAY = BigNumber.from(10).pow(27);
const PREMIUM_BPS = BigNumber.from(9999); // near-max premium, so the in-test barrage needs few flashes
const ceilMul = (a: BigNumber, bps: BigNumber) => a.mul(bps).add(9999).div(10000); // percentMulCeil

makeSuite('Neverland security: flash-loan index inflation harvest', (testEnv: TestEnv) => {
  let snap: string;
  beforeEach(async () => {
    snap = await evmSnapshot();
  });
  afterEach(async () => {
    await evmRevert(snap);
  });

  it('a flash barrage cannot inflate the index, so a later supplier keeps their full deposit', async () => {
    const {
      deployer,
      users: [attacker, victim],
      pool,
      configurator,
      usdc,
      aUsdc,
      addressesProvider,
    } = testEnv;

    await waitForTx(await configurator.updateFlashloanPremiumTotal(PREMIUM_BPS));
    await waitForTx(await configurator.updateFlashloanPremiumToProtocol(0)); // 100% to LP on OLD
    await waitForTx(await configurator.setReserveFlashLoaning(usdc.address, true));

    // Attacker seeds 1 base unit and becomes the sole supplier.
    await waitForTx(
      await usdc
        .connect(attacker.signer)
        ['mint(uint256)'](await convertToCurrencyDecimals(usdc.address, '1000000'))
    );
    await waitForTx(await usdc.connect(attacker.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(attacker.signer).supply(usdc.address, 1, attacker.address, '0')
    );

    const idxBefore = BigNumber.from((await pool.getReserveData(usdc.address)).liquidityIndex);

    const receiver = await (
      await hre.ethers.getContractFactory('MockFlashLoanReceiverForRounding', deployer.signer)
    ).deploy(addressesProvider.address);
    await receiver.deployed();

    // Self-funded flash barrage. Flash exactly totalSupply() (satisfies the totalSupply() >= amount
    // flashloan guard), pre-funding the premium. On OLD each flash ~doubles the index.
    for (let i = 0; i < 20; i++) {
      const ts = await aUsdc.totalSupply();
      const cash = await usdc.balanceOf(aUsdc.address);
      const amount = cash.lt(ts) ? cash : ts; // flash <= cash AND <= totalSupply() (the flashloan guard)
      const premium = ceilMul(amount, PREMIUM_BPS);
      await waitForTx(
        await usdc.connect(attacker.signer).transfer(receiver.address, premium.add(10))
      );
      await waitForTx(
        await pool
          .connect(attacker.signer)
          .flashLoanSimple(receiver.address, usdc.address, amount, '0x', '0')
      );
    }

    const idxAfter = BigNumber.from((await pool.getReserveData(usdc.address)).liquidityIndex);
    const granularity = idxAfter.div(RAY); // value credited per scaled unit

    // A later supplier deposits ~1.5 granularities. On OLD their shares floor to 1 unit (worth G),
    // losing ~0.5G; on NEW the index is RAY so G == 1 and they keep everything.
    const victimDeposit = granularity.mul(3).div(2).add(1);
    await waitForTx(await usdc.connect(victim.signer)['mint(uint256)'](victimDeposit.mul(4)));
    await waitForTx(await usdc.connect(victim.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(victim.signer).supply(usdc.address, victimDeposit, victim.address, '0')
    );

    const victimBalance = await aUsdc.balanceOf(victim.address);

    // Lever: a flash barrage does not move the index (on the old split it inflated ~1e6x here).
    expect(idxAfter).to.eq(idxBefore);
    // Extraction: the later supplier is credited their exact deposit, no rounding harvest (on the old
    // split they lost ~33% of the deposit to the inflated share granularity).
    expect(victimBalance).to.eq(victimDeposit);
  });
});
