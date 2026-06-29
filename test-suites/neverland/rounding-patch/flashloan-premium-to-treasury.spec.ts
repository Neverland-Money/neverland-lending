/*
 * Neverland rounding patch: flash-loan premium routes entirely to the treasury.
 *
 * The patch drops the retained v3.0.2 LP/protocol split (no `cumulateToLiquidityIndex` liquidityIndex
 * bump) and routes the FULL premium to `accruedToTreasury` via the floor `getATokenMintScaledAmount`
 * mint, matching upstream v3.5
 * `_handleFlashLoanRepayment`. Consequences pinned here (with no borrows -> supply rate 0, so the
 * index is not moved by interest either):
 *   - accruedToTreasury grows by exactly `rayDivFloor(totalPremium, index)` (the full premium),
 *   - the premium does NOT bump liquidityIndex,
 *   - supplier aToken balances do NOT grow from the premium.
 * With no index-bump leg, there is no LP-share over-credit residue.
 *
 * VARIABLE RATE ONLY.
 */

import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

declare var hre: HardhatRuntimeEnvironment;

const RAY = BigNumber.from(10).pow(27);
const FLASH_BPS = BigNumber.from(9); // 0.09%
const rayDivFloor = (a: BigNumber, b: BigNumber) => a.mul(RAY).div(b);
const premiumCeil = (amount: BigNumber) => amount.mul(FLASH_BPS).add(9999).div(10000); // percentMulCeil

makeSuite('Neverland rounding patch: flash-loan premium to treasury', (testEnv: TestEnv) => {
  let snap: string;

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  it('routes the full flash-loan premium to the treasury, with no liquidityIndex bump and no supplier credit', async () => {
    const {
      deployer,
      users: [depositor],
      pool,
      configurator,
      dai,
      aDai,
      addressesProvider,
    } = testEnv;

    await waitForTx(await configurator.updateFlashloanPremiumTotal(FLASH_BPS));
    await waitForTx(await configurator.updateFlashloanPremiumToProtocol(0)); // would route ALL to LP pre-change
    await waitForTx(await configurator.setReserveFlashLoaning(dai.address, true));

    // Seed DAI liquidity; NO borrows -> supply rate 0 -> liquidityIndex is not moved by interest.
    const liquidity = await convertToCurrencyDecimals(dai.address, '1000000');
    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](liquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, liquidity));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, liquidity, depositor.address, '0')
    );

    const receiver = await (
      await hre.ethers.getContractFactory('MockFlashLoanReceiverForRounding', deployer.signer)
    ).deploy(addressesProvider.address);
    await receiver.deployed();
    const preFund = await convertToCurrencyDecimals(dai.address, '1000');
    await waitForTx(await dai['mint(address,uint256)'](receiver.address, preFund));

    const flashAmount = await convertToCurrencyDecimals(dai.address, '450000');
    const totalPremium = premiumCeil(flashAmount);

    const before = await pool.getReserveData(dai.address);
    const idx0 = BigNumber.from(before.liquidityIndex);
    const treasuryScaled0 = BigNumber.from(before.accruedToTreasury);
    const supplyBefore = await aDai.totalSupply();

    await waitForTx(
      await pool.flashLoanSimple(receiver.address, dai.address, flashAmount, '0x', '0')
    );

    const after = await pool.getReserveData(dai.address);
    const idx1 = BigNumber.from(after.liquidityIndex);
    const treasuryScaled1 = BigNumber.from(after.accruedToTreasury);
    const supplyAfter = await aDai.totalSupply();

    // Non-vacuous: a premium was actually charged.
    expect(totalPremium).to.be.gt(0);
    // The premium does NOT bump the liquidity index (no LP index-bump; rate 0 -> no interest either).
    expect(idx1).to.eq(idx0);
    // accruedToTreasury grows by exactly the full premium's floored scaled amount.
    expect(treasuryScaled1.sub(treasuryScaled0)).to.eq(rayDivFloor(totalPremium, idx1));
    // Suppliers receive nothing from the premium.
    expect(supplyAfter).to.eq(supplyBefore);
  });
});
