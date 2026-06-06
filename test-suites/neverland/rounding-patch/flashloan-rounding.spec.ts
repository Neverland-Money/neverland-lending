/*
 * Neverland rounding patch: flashLoanSimple premium rounding on the REAL Pool.
 *
 * This re-expresses the POOL-repo regression spec
 *   neverland-lending-pool/tests/rounding/06-flashloan-rounding.spec.ts
 * onto the LENDING `makeSuite` harness (the fixture already deploys the
 * patched stack: real Pool, patched ATokenPEV3 / VariableDebtTokenPEV2).
 *
 * The patched FlashLoanLogic computes the total premium with
 * `percentMulCeil(amount, FLASHLOAN_PREMIUM_TOTAL)` rather than the v3.0.2
 * half-up `percentMul`, so the protocol always collects the full wei of fee
 * (never loses 1 wei per loan to the borrower).
 *
 * Behaviors covered:
 *   1. Per-loop premium == percentMulCeil(amount, FLASHLOAN_PREMIUM_TOTAL),
 *      measured as the NON-MINTING receiver's underlying balance drop, over
 *      K loops with zero cumulative drift (ceilTotal - sumPaid == 0).
 *   2. Boundary pin: at amount=555 / 9 bps the half-up reference rounds to 0
 *      while ceil rounds to 1 (drift = +1 wei), so the test is exactly on
 *      the divergence boundary that proves the patched direction.
 *   3. Treasury-share routing when premiumToProtocol > 0: accruedToTreasury
 *      (and the treasury aToken balance after mintToTreasury) grows by the
 *      expected protocol share.
 *
 * VARIABLE RATE ONLY (flashLoanSimple has no rate mode; no borrow/repay here
 * uses anything other than the variable path).
 */

import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { getVariableDebtToken } from '@aave/deploy-v3/dist/helpers/contract-getters';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

declare var hre: HardhatRuntimeEnvironment;

const PERCENTAGE_FACTOR = BigNumber.from(10_000);
const HALF_PERCENT = PERCENTAGE_FACTOR.div(2);
const RAY = BigNumber.from(10).pow(27);

// Reference TS oracles for the half-up vs ceil percentMul. These mirror the
// inline directional oracles in the porting kit; .percentMul() from
// utils/wadraymath is HALF-UP and would NOT prove the patched direction.
function percentMulHalfUp(amount: BigNumber, bps: BigNumber): BigNumber {
  // v3.0.2 PercentageMath: (amount * bps + 5_000) / 10_000
  return amount.mul(bps).add(HALF_PERCENT).div(PERCENTAGE_FACTOR);
}
function percentMulCeil(amount: BigNumber, bps: BigNumber): BigNumber {
  // Patched PercentageMath.percentMulCeil: ceil((amount * bps) / 10_000).
  const num = amount.mul(bps);
  const q = num.div(PERCENTAGE_FACTOR);
  return num.mod(PERCENTAGE_FACTOR).isZero() ? q : q.add(1);
}
function rayDivFloor(amount: BigNumber, index: BigNumber): BigNumber {
  return amount.mul(RAY).div(index);
}

const FLASH_PREMIUM_TOTAL_BPS = BigNumber.from(9); // 0.09%, v3.0.2 default.

makeSuite('Neverland rounding patch: flashloan premium rounding', (testEnv: TestEnv) => {
  let snapId: string;

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  it('charges percentMulCeil premium per loop with zero cumulative drift (K loops)', async () => {
    const {
      deployer,
      users: [liquidity],
      pool,
      configurator,
      weth,
      addressesProvider,
    } = testEnv;

    // 1. Premium config: 9 bps total, all to LPs (protocol share 0) so the
    //    full premium leaves the receiver and lands on the reserve.
    await waitForTx(await configurator.updateFlashloanPremiumTotal(FLASH_PREMIUM_TOTAL_BPS));
    await waitForTx(await configurator.updateFlashloanPremiumToProtocol(0));
    await waitForTx(await configurator.setReserveFlashLoaning(weth.address, true));
    expect(await pool.FLASHLOAN_PREMIUM_TOTAL()).to.equal(FLASH_PREMIUM_TOTAL_BPS);

    // 2. Seed WETH liquidity so flashLoanSimple has something to lend.
    const seedAmount = await convertToCurrencyDecimals(weth.address, '100');
    await weth.connect(liquidity.signer)['mint(address,uint256)'](liquidity.address, seedAmount);
    await weth.connect(liquidity.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(liquidity.signer).supply(weth.address, seedAmount, liquidity.address, '0');

    // 3. Deploy the rounding-friendly receiver (non-minting, pre-funded). Its
    //    net underlying outflow per flashLoanSimple is exactly the premium.
    const ReceiverFactory = await hre.ethers.getContractFactory(
      'MockFlashLoanReceiverForRounding',
      deployer.signer
    );
    const receiver = await ReceiverFactory.deploy(addressesProvider.address);
    await receiver.deployed();

    // 4. Boundary amount: 555 base units (wei) at 9 bps -> 555*9 = 4_995,
    //    mod 10_000 = 4_995 < 5_000, so half-up = 0 but ceil = 1. The patched
    //    stack must charge 1 per loop.
    const flashAmount = BigNumber.from(555);
    const expectedHalfUp = percentMulHalfUp(flashAmount, FLASH_PREMIUM_TOTAL_BPS);
    const expectedCeil = percentMulCeil(flashAmount, FLASH_PREMIUM_TOTAL_BPS);
    const expectedDrift = expectedCeil.sub(expectedHalfUp);

    // Boundary pins: keep the fixture on the exact 1-wei divergence.
    expect(expectedHalfUp).to.equal(0, 'half-up premium must be 0 at this boundary');
    expect(expectedCeil).to.equal(1, 'ceil premium must be 1 at this boundary');
    expect(expectedDrift).to.equal(1, 'per-loop drift must be exactly +1 wei');

    // 5. Pre-fund the receiver with a premium budget (1 WETH; overkill).
    const preFund = await convertToCurrencyDecimals(weth.address, '1');
    await weth['mint(address,uint256)'](receiver.address, preFund);

    // 6. Run K loops; per-iter premium = receiver underlying balance drop.
    const K = 25;
    const receiverBalBefore = await weth.balanceOf(receiver.address);
    const perIterPremiums: BigNumber[] = [];
    let prevBal = receiverBalBefore;

    for (let i = 0; i < K; i++) {
      await waitForTx(
        await pool.flashLoanSimple(receiver.address, weth.address, flashAmount, '0x', '0')
      );
      const balAfter = await weth.balanceOf(receiver.address);
      perIterPremiums.push(prevBal.sub(balAfter));
      prevBal = balAfter;
    }

    const receiverBalAfter = await weth.balanceOf(receiver.address);
    const totalPremiumPaid = receiverBalBefore.sub(receiverBalAfter);

    // 7. Non-vacuous: the receiver strictly paid out and exactly K * ceil.
    expect(perIterPremiums.length).to.equal(K, 'must have run K loops');
    expect(totalPremiumPaid).to.equal(
      expectedCeil.mul(K),
      `total premium ${totalPremiumPaid.toString()} != K * ceil ${expectedCeil.mul(K).toString()}`
    );
    expect(totalPremiumPaid).to.be.gt(0, 'receiver must have strictly paid premium');

    // 8. Drift assertion (the regression marker): zero drift vs the ceil
    //    reference. A future regression back to half-up would drop per-loop
    //    premium to 0 and make cumulativeDrift = expectedCeil * K != 0.
    const ceilTotal = expectedCeil.mul(K);
    const cumulativeDrift = ceilTotal.sub(totalPremiumPaid);
    expect(cumulativeDrift).to.equal(
      0,
      `cumulative drift vs ceil ${cumulativeDrift.toString()} != 0`
    );

    // 9. Per-iter pin: every loop charged exactly `expectedCeil`.
    for (let i = 0; i < K; i++) {
      expect(perIterPremiums[i]).to.equal(
        expectedCeil,
        `iteration ${i}: per-iter premium ${perIterPremiums[
          i
        ].toString()} != ${expectedCeil.toString()}`
      );
    }
  }).timeout(120_000);

  it('rejects duplicate multi-asset flashloan assets before the receiver callback', async () => {
    const {
      users: [caller],
      pool,
      dai,
      aDai,
    } = testEnv;

    await expect(
      pool
        .connect(caller.signer)
        .flashLoan(
          aDai.address,
          [dai.address, dai.address],
          [1, 1],
          [RateMode.None, RateMode.None],
          caller.address,
          '0x',
          0
        )
    ).to.be.revertedWith(ProtocolErrors.INCONSISTENT_FLASHLOAN_PARAMS);
  });

  it('re-reads onBehalfOf eMode after receiver callback before opening debt', async () => {
    const {
      deployer,
      users: [liquidity, caller],
      pool,
      configurator,
      helpersContract,
      addressesProvider,
      dai,
      usdc,
    } = testEnv;

    const EMODE_ID = 1;
    await waitForTx(
      await configurator.setEModeCategory(EMODE_ID, 9000, 9500, 10100, ZERO_ADDRESS, 'FLASH-EMODE')
    );
    await waitForTx(await configurator.setAssetEModeCategory(dai.address, EMODE_ID));
    await waitForTx(await configurator.setAssetEModeCategory(usdc.address, EMODE_ID));
    await waitForTx(await configurator.setReserveFlashLoaning(usdc.address, true));

    const usdcLiquidity = await convertToCurrencyDecimals(usdc.address, '1000000');
    await usdc.connect(liquidity.signer)['mint(uint256)'](usdcLiquidity);
    await usdc.connect(liquidity.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(liquidity.signer)
      .supply(usdc.address, usdcLiquidity, liquidity.address, '0');

    const receiverFactory = await hre.ethers.getContractFactory(
      'MockFlashLoanReceiverEModeSwitch',
      deployer.signer
    );
    const receiver = await receiverFactory.deploy(addressesProvider.address);
    await receiver.deployed();

    const daiCollateral = await convertToCurrencyDecimals(dai.address, '10000');
    await dai['mint(address,uint256)'](receiver.address, daiCollateral);
    await waitForTx(await receiver.supply(dai.address, daiCollateral));

    const { variableDebtTokenAddress } = await helpersContract.getReserveTokensAddresses(
      usdc.address
    );
    await waitForTx(
      await receiver.approveDelegation(variableDebtTokenAddress, caller.address, MAX_UINT_AMOUNT)
    );

    const borrowUsdc = await convertToCurrencyDecimals(usdc.address, '8500');
    const userDataBefore = await pool.getUserAccountData(receiver.address);
    expect(await pool.getUserEMode(receiver.address)).to.eq(0);
    expect(userDataBefore.ltv).to.be.lt(9000);

    await waitForTx(
      await pool
        .connect(caller.signer)
        .flashLoan(
          receiver.address,
          [usdc.address],
          [borrowUsdc],
          [RateMode.Variable],
          receiver.address,
          hre.ethers.utils.defaultAbiCoder.encode(['uint8'], [EMODE_ID]),
          0
        )
    );

    expect(await pool.getUserEMode(receiver.address)).to.eq(EMODE_ID);
    const variableDebtUsdc = await getVariableDebtToken(variableDebtTokenAddress);
    expect(await variableDebtUsdc.balanceOf(receiver.address)).to.be.gte(borrowUsdc);
  });

  it('routes the expected protocol share to the treasury when premiumToProtocol > 0', async () => {
    const {
      deployer,
      users: [liquidity],
      pool,
      configurator,
      helpersContract,
      weth,
      aWETH,
      addressesProvider,
    } = testEnv;

    const PREMIUM_TO_PROTOCOL = BigNumber.from(3000); // 30% of total premium.

    // 1. Premium config: 9 bps total, 30% to protocol.
    await waitForTx(await configurator.updateFlashloanPremiumTotal(FLASH_PREMIUM_TOTAL_BPS));
    await waitForTx(await configurator.updateFlashloanPremiumToProtocol(PREMIUM_TO_PROTOCOL));
    await waitForTx(await configurator.setReserveFlashLoaning(weth.address, true));
    expect(await pool.FLASHLOAN_PREMIUM_TOTAL()).to.equal(FLASH_PREMIUM_TOTAL_BPS);
    expect(await pool.FLASHLOAN_PREMIUM_TO_PROTOCOL()).to.equal(PREMIUM_TO_PROTOCOL);

    // 2. Seed WETH liquidity.
    const seedAmount = await convertToCurrencyDecimals(weth.address, '100');
    await weth.connect(liquidity.signer)['mint(address,uint256)'](liquidity.address, seedAmount);
    await weth.connect(liquidity.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(liquidity.signer).supply(weth.address, seedAmount, liquidity.address, '0');

    // 3. Deploy + pre-fund the non-minting receiver.
    const ReceiverFactory = await hre.ethers.getContractFactory(
      'MockFlashLoanReceiverForRounding',
      deployer.signer
    );
    const receiver = await ReceiverFactory.deploy(addressesProvider.address);
    await receiver.deployed();
    const preFund = await convertToCurrencyDecimals(weth.address, '1');
    await weth['mint(address,uint256)'](receiver.address, preFund);

    // 4. Realistic amount (0.8 WETH) so the protocol share is strictly > 0.
    const flashAmount = await convertToCurrencyDecimals(weth.address, '0.8');
    const totalFees = percentMulCeil(flashAmount, FLASH_PREMIUM_TOTAL_BPS);
    // FlashLoanLogic splits the (ceil) total with half-up percentMul (line 240
    // of FlashLoanLogic.sol): protocol share = percentMul(total, premiumToProtocol).
    const feesToProtocol = percentMulHalfUp(totalFees, PREMIUM_TO_PROTOCOL);
    expect(feesToProtocol).to.be.gt(0, 'protocol share must be strictly positive at this amount');

    const treasury = await aWETH.RESERVE_TREASURY_ADDRESS();
    const accruedBefore = (await pool.getReserveData(weth.address)).accruedToTreasury;
    const treasuryBalBefore = await aWETH.balanceOf(treasury);

    // 5. Execute the flash loan; the receiver pays the full premium.
    const receiverBalBefore = await weth.balanceOf(receiver.address);
    await waitForTx(
      await pool.flashLoanSimple(receiver.address, weth.address, flashAmount, '0x', '0')
    );
    const receiverBalAfter = await weth.balanceOf(receiver.address);

    // Non-vacuous: the receiver actually paid the full (ceil) premium.
    expect(receiverBalBefore.sub(receiverBalAfter)).to.equal(
      totalFees,
      'receiver outflow must equal the full ceil premium'
    );

    // 6. The protocol share accrued to treasury (scaled counter strictly grew).
    const accruedAfter = (await pool.getReserveData(weth.address)).accruedToTreasury;
    expect(accruedAfter).to.be.gt(accruedBefore, 'accruedToTreasury must strictly grow');

    // 7. Realize it and confirm the treasury aToken balance grew by the
    //    expected protocol share (closeTo: scaling rounds within a couple wei).
    await waitForTx(await pool.mintToTreasury([weth.address]));
    const treasuryBalAfter = await aWETH.balanceOf(treasury);
    expect(treasuryBalAfter.sub(treasuryBalBefore)).to.be.closeTo(feesToProtocol, 2);
    expect(treasuryBalAfter).to.be.gt(treasuryBalBefore, 'treasury balance must strictly grow');

    // 8. Cross-check the data provider exposes the same flashloan-enabled flag.
    expect(await helpersContract.getFlashLoanEnabled(weth.address)).to.equal(true);
  }).timeout(120_000);

  it('keeps sub-scaled protocol-share dust in reserve cash instead of over-crediting treasury', async () => {
    const {
      deployer,
      users: [liquidity],
      pool,
      configurator,
      weth,
      aWETH,
      addressesProvider,
    } = testEnv;

    await waitForTx(await configurator.updateFlashloanPremiumTotal(FLASH_PREMIUM_TOTAL_BPS));
    await waitForTx(await configurator.updateFlashloanPremiumToProtocol(0));
    await waitForTx(await configurator.setReserveFlashLoaning(weth.address, true));

    const seedAmount = await convertToCurrencyDecimals(weth.address, '100');
    await weth.connect(liquidity.signer)['mint(address,uint256)'](liquidity.address, seedAmount);
    await weth.connect(liquidity.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(liquidity.signer).supply(weth.address, seedAmount, liquidity.address, '0');

    const ReceiverFactory = await hre.ethers.getContractFactory(
      'MockFlashLoanReceiverForRounding',
      deployer.signer
    );
    const receiver = await ReceiverFactory.deploy(addressesProvider.address);
    await receiver.deployed();
    await weth['mint(address,uint256)'](
      receiver.address,
      await convertToCurrencyDecimals(weth.address, '1')
    );

    const indexLiftFlashAmount = await convertToCurrencyDecimals(weth.address, '10');
    await waitForTx(
      await pool.flashLoanSimple(receiver.address, weth.address, indexLiftFlashAmount, '0x', '0')
    );

    const reserveAfterIndexLift = await pool.getReserveData(weth.address);
    expect(reserveAfterIndexLift.liquidityIndex).to.be.gt(RAY);

    await waitForTx(await configurator.updateFlashloanPremiumToProtocol(PERCENTAGE_FACTOR));

    const dustFlashAmount = BigNumber.from(555);
    const totalFees = percentMulCeil(dustFlashAmount, FLASH_PREMIUM_TOTAL_BPS);
    const feesToProtocol = percentMulHalfUp(totalFees, PERCENTAGE_FACTOR);
    expect(totalFees).to.equal(1);
    expect(feesToProtocol).to.equal(1);
    expect(rayDivFloor(feesToProtocol, reserveAfterIndexLift.liquidityIndex)).to.equal(0);

    const accruedBefore = reserveAfterIndexLift.accruedToTreasury;
    const receiverBalBefore = await weth.balanceOf(receiver.address);
    const aTokenCashBefore = await weth.balanceOf(aWETH.address);

    await waitForTx(
      await pool.flashLoanSimple(receiver.address, weth.address, dustFlashAmount, '0x', '0')
    );

    const receiverBalAfter = await weth.balanceOf(receiver.address);
    const aTokenCashAfter = await weth.balanceOf(aWETH.address);
    const accruedAfter = (await pool.getReserveData(weth.address)).accruedToTreasury;

    expect(receiverBalBefore.sub(receiverBalAfter)).to.equal(totalFees);
    expect(accruedAfter).to.equal(accruedBefore);
    expect(aTokenCashAfter.sub(aTokenCashBefore)).to.equal(totalFees);
  }).timeout(120_000);
});
