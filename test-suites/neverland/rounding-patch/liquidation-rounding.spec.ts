/*
 * Liquidation rounding coverage on the REAL patched Pool (makeSuite harness).
 *
 * Re-expresses, on the LENDING makeSuite fixture and VARIABLE-rate only, the
 * POOL-repo liquidation invariants from
 *   tests/rounding/05-liquidation-rounding.spec.ts
 *   tests/rounding/pool-flashloan-liquidation.spec.ts (the `liquidationCall`
 *   describe block, especially the closed-form fee split and the K-loop).
 *
 * Behaviors:
 *   (a) Collateral/debt ceil-floor split favors the protocol. With a
 *       liquidation protocol fee enabled on the WETH collateral reserve, a
 *       single liquidationCall must realize the exact closed-form split:
 *         baseCollateral  = floor over the price/decimal ratio
 *         collateralAmount = percentMulFloor(baseCollateral, liquidationBonus)
 *         bonusBase       = percentDivFloor(collateralAmount, liquidationBonus)
 *         protocolFee     = percentMulCeil(collateralAmount - bonusBase, fee)
 *         liquidatorReward = collateralAmount - protocolFee
 *       asserted against the LiquidationCall event's liquidatedCollateralAmount,
 *       the treasury aWETH delta (== protocolFee), the borrower aWETH delta
 *       (== collateralAmount) and the liquidator underlying WETH delta
 *       (== liquidatorReward). The fee path rounds the protocol's cut UP
 *       (ceil) and the liquidator's reward DOWN, i.e. in the protocol's favor.
 *
 *   (b) A K-loop of small fixed liquidations accrues NO cumulative
 *       liquidator-favoring extraction: every iteration's debt-asset outflow
 *       is exactly debtPerCall (per-iter delta == -debtPerCall), the
 *       per-iter collateral delta to the liquidator with receiveAToken=false
 *       is exactly 0, the treasury collateral aToken balance strictly grows
 *       across the loop, and totalLiquidations == K (non-vacuous: a silent
 *       early revert in the protocol-fee guard would fail this).
 *
 *   (c) A dust under-water position remains fully liquidatable: a maxed-out
 *       liquidationCall(MAX_UINT_AMOUNT) must not revert with
 *       "ERC20: burn amount exceeds balance" and must strictly reduce the
 *       borrower's debt.
 *
 *   (d) A receiveAToken liquidation that drains the borrower's scaled
 *       collateral balance must clear the collateral bit even when the visible
 *       amount is a strict partial.
 *
 *   (e) Same-asset liquidations leave reserve rates equal to the post-action
 *       net-liquidity state.
 *
 *   (f) The collateral-capped branch repays the ceil-rounded debt needed to
 *       consume the available collateral.
 *
 * Prices are moved via the mutable PriceOracle (setAssetPrice) after wiring
 * addressesProvider.setPriceOracle(oracle.address) in before(); restored in
 * after(). Per-test isolation via evmSnapshot/evmRevert.
 */

import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  DefaultReserveInterestRateStrategy__factory,
  evmSnapshot,
  evmRevert,
  increaseTime,
  IStableDebtToken__factory,
  waitForTx,
} from '@aave/deploy-v3';
import { MAX_UINT_AMOUNT, oneEther } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import '../../helpers/utils/wadraymath';

declare var hre: HardhatRuntimeEnvironment;

const RAY = BigNumber.from(10).pow(27);
const PF = BigNumber.from(10000);
const HALF_PF = PF.div(2);

// Inline directional oracles (kit section "Inline directional oracles").
const percentMulFloor = (a: BigNumber, bps: BigNumber) => a.mul(bps).div(PF);
const percentMulCeil = (a: BigNumber, bps: BigNumber) => {
  const n = a.mul(bps);
  const q = n.div(PF);
  return n.mod(PF).isZero() ? q : q.add(1);
};
const percentMulHalfUp = (a: BigNumber, bps: BigNumber) => a.mul(bps).add(HALF_PF).div(PF);
const percentDivFloor = (a: BigNumber, bps: BigNumber) => a.mul(PF).div(bps);
const percentDivHalfUp = (a: BigNumber, bps: BigNumber) => a.mul(PF).add(bps.div(2)).div(bps);
const ceilDiv = (a: BigNumber, b: BigNumber) => a.add(b).sub(1).div(b);
const percentDivCeil = (a: BigNumber, bps: BigNumber) => ceilDiv(a.mul(PF), bps);
const rayDivCeil = (a: BigNumber, b: BigNumber) => ceilDiv(a.mul(RAY), b);

const LIQUIDATION_CALL_IFACE = [
  'event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)',
];

makeSuite('Neverland rounding patch: liquidation rounding', (testEnv: TestEnv) => {
  let snap: string;

  before(async () => {
    const { addressesProvider, oracle } = testEnv;
    // Route pricing through the mutable PriceOracle so setAssetPrice works
    // (the AaveOracle aggregators have no setter).
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

  const collateralBit = async (user: string, asset: string): Promise<number> => {
    const { pool } = testEnv;
    const userConfig = await pool.getUserConfiguration(user);
    const reserveId: number = (await pool.getReserveData(asset)).id;
    return BigNumber.from(userConfig.data)
      .shr(reserveId * 2 + 1)
      .and(1)
      .toNumber();
  };

  it('(a) realizes the exact closed-form protocol-fee collateral split (protocol rounds up, liquidator down)', async () => {
    const {
      pool,
      users: [depositor, borrower, liquidator],
      dai,
      weth,
      aWETH,
      variableDebtDai,
      oracle,
      configurator,
      poolAdmin,
      helpersContract,
    } = testEnv;

    // Odd protocol-fee bps so the fee-ceil residue is reachable.
    const PROTOCOL_FEE_BPS = 3333;
    await waitForTx(
      await configurator
        .connect(poolAdmin.signer)
        .setLiquidationProtocolFee(weth.address, PROTOCOL_FEE_BPS)
    );
    expect(await helpersContract.getLiquidationProtocolFee(weth.address)).to.eq(PROTOCOL_FEE_BPS);

    // Depositor seeds the DAI debt asset.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    // Borrower posts WETH collateral and borrows DAI near max (variable).
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '10');
    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');
    await pool.connect(borrower.signer).setUserUseReserveAsCollateral(weth.address, true);

    const accountData = await pool.getUserAccountData(borrower.address);
    const daiPrice0 = await oracle.getAssetPrice(dai.address);
    const toBorrow = await convertToCurrencyDecimals(
      dai.address,
      accountData.availableBorrowsBase.div(daiPrice0).percentMul(9500).toString()
    );
    await pool
      .connect(borrower.signer)
      .borrow(dai.address, toBorrow, RateMode.Variable, '0', borrower.address);

    // Drop HF below 1 by bumping the DAI (debt) price. Use odd-priced
    // oracles so the floor/ceil residues are reachable on the split.
    const collateralPrice = (await oracle.getAssetPrice(weth.address)).add(7);
    const principalPrice = daiPrice0.percentMul(11500).add(123);
    await waitForTx(await oracle.setAssetPrice(weth.address, collateralPrice));
    await waitForTx(await oracle.setAssetPrice(dai.address, principalPrice));

    const hf = (await pool.getUserAccountData(borrower.address)).healthFactor;
    expect(hf).to.be.lt(oneEther);

    // Liquidator funds DAI to repay the debt asset.
    const liquidatorBudget = await convertToCurrencyDecimals(dai.address, '100000');
    await dai.connect(liquidator.signer)['mint(uint256)'](liquidatorBudget);
    await dai.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT);

    const wethConfig = await helpersContract.getReserveConfigurationData(weth.address);
    const daiConfig = await helpersContract.getReserveConfigurationData(dai.address);
    const liquidationBonus = BigNumber.from(wethConfig.liquidationBonus);
    const collateralDecimals = BigNumber.from(wethConfig.decimals);
    const principalDecimals = BigNumber.from(daiConfig.decimals);

    // Closed-form V3.7 directional split. Mirrors
    // LiquidationLogic._calculateAvailableCollateralToLiquidate exactly:
    //   baseCollateral    = floor((debtPrice*debtToCover*colUnit)/(colPrice*debtUnit))
    //   collateralAmount  = percentMulFloor(baseCollateral, liquidationBonus)
    //   bonusCollateral   = collateralAmount - percentDivFloor(collateralAmount, bonus)
    //   protocolFee       = percentMulCeil(bonusCollateral, protocolFeeBps)
    //   liquidatorReward  = collateralAmount - protocolFee
    const collateralUnit = BigNumber.from(10).pow(collateralDecimals);
    const debtUnit = BigNumber.from(10).pow(principalDecimals);

    // Pick a concrete, sane debtToCover: a few DAI, well under the 50%
    // close-factor cap on this large borrow. No fragile dual-residue search:
    // the closed-form split below IS the rounding-direction proof regardless
    // of which exact amount we cover, and the non-vacuity guards confirm the
    // liquidation actually moved collateral.
    const currentDebt = await variableDebtDai.balanceOf(borrower.address);
    const debtToCover = await convertToCurrencyDecimals(dai.address, '5');
    expect(debtToCover).to.be.gt(0);
    expect(debtToCover).to.be.lt(
      currentDebt.div(2),
      'debtToCover must stay under the 50% close-factor cap'
    );

    // Closed-form directional split for the chosen debtToCover, mirroring
    // LiquidationLogic._calculateAvailableCollateralToLiquidate exactly.
    // Defined unconditionally so no expected/actual value can be undefined.
    const baseCollateral = principalPrice
      .mul(debtToCover)
      .mul(collateralUnit)
      .div(collateralPrice.mul(debtUnit));
    const collateralAmount = percentMulFloor(baseCollateral, liquidationBonus);
    const halfUpCollateralAmount = percentMulHalfUp(baseCollateral, liquidationBonus);
    const bonusBase = percentDivFloor(collateralAmount, liquidationBonus);
    const bonusCollateral = collateralAmount.sub(bonusBase);
    const expectedProtocolFee = percentMulCeil(bonusCollateral, BigNumber.from(PROTOCOL_FEE_BPS));
    const expectedLiquidatorReward = collateralAmount.sub(expectedProtocolFee);

    // Premise (relaxed, always true): the patched max-collateral floor never
    // rounds ABOVE the legacy half-up, i.e. never in the liquidator's favor.
    expect(collateralAmount).to.be.lte(
      halfUpCollateralAmount,
      'premise: V3.7 max-collateral floor must not exceed legacy half-up'
    );

    const treasuryAddress = await aWETH.RESERVE_TREASURY_ADDRESS();
    const treasuryAColBefore = await aWETH.balanceOf(treasuryAddress);
    const borrowerAColBefore = await aWETH.balanceOf(borrower.address);
    const liquidatorWethBefore = await weth.balanceOf(liquidator.address);

    const tx = await pool
      .connect(liquidator.signer)
      .liquidationCall(weth.address, dai.address, borrower.address, debtToCover, false);
    const receipt = await waitForTx(tx);

    const liquidationIface = new utils.Interface(LIQUIDATION_CALL_IFACE);
    const liquidationEvent = receipt.logs
      .map((log) => {
        try {
          return liquidationIface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event?.name === 'LiquidationCall');
    expect(liquidationEvent, 'LiquidationCall event must be emitted').to.not.eq(undefined);

    const treasuryAColAfter = await aWETH.balanceOf(treasuryAddress);
    const borrowerAColAfter = await aWETH.balanceOf(borrower.address);
    const liquidatorWethAfter = await weth.balanceOf(liquidator.address);

    const treasuryDelta = treasuryAColAfter.sub(treasuryAColBefore);
    const borrowerCollateralDrop = borrowerAColBefore.sub(borrowerAColAfter);
    const liquidatorWethDelta = liquidatorWethAfter.sub(liquidatorWethBefore);

    // The event is emitted from the computed liquidator reward before any
    // aToken index movement can blur balance deltas, so it must be exact.
    expect(liquidationEvent!.args.debtToCover).to.equal(debtToCover);
    expect(liquidationEvent!.args.liquidatedCollateralAmount).to.equal(
      expectedLiquidatorReward,
      'liquidatedCollateralAmount (liquidator reward) must equal collateralAmount - ceil(protocolFee)'
    );

    // Balance deltas pass through aToken scaled transfers, so keep a narrow
    // tolerance there while the event pins the 1-wei split exactly.
    expect(treasuryDelta).to.be.closeTo(
      expectedProtocolFee,
      2,
      'treasury aWETH must grow by the ceil-rounded protocol fee'
    );
    expect(borrowerCollateralDrop).to.be.closeTo(
      collateralAmount,
      2,
      'borrower aWETH must drop by the floored total collateral amount (reward + fee)'
    );
    expect(liquidatorWethDelta).to.be.closeTo(
      expectedLiquidatorReward,
      2,
      'liquidator underlying WETH must grow by the post-fee reward'
    );

    // Non-vacuity: the liquidation actually moved collateral on every leg
    // (otherwise the closeTo split assertions could pass on a no-op).
    expect(debtToCover).to.be.gt(0);
    expect(treasuryDelta).to.be.gt(0, 'treasury collateral must strictly increase');
    expect(liquidatorWethDelta).to.be.gt(0, 'liquidator must receive collateral');
    expect(borrowerCollateralDrop).to.be.gt(0, 'borrower collateral must strictly decrease');
    expect(expectedProtocolFee).to.be.gt(0);
    expect(expectedLiquidatorReward).to.be.gt(0);
    expect(collateralAmount).to.be.gt(0);
  });

  it('(b) K small fixed liquidations: exact per-iter debt outflow, zero liquidator collateral delta, treasury grows, all K succeed', async () => {
    const {
      pool,
      users: [depositor, borrower, liquidator],
      dai,
      weth,
      aWETH,
      variableDebtDai,
      oracle,
      configurator,
      poolAdmin,
    } = testEnv;

    const loopSnap = await evmSnapshot();

    // Protocol fee enabled on the WETH collateral so the per-iter fee
    // transfer step (the dust-edge revert surface) actually runs.
    const PROTOCOL_FEE_BPS = 1000;
    await waitForTx(
      await configurator
        .connect(poolAdmin.signer)
        .setLiquidationProtocolFee(weth.address, PROTOCOL_FEE_BPS)
    );

    // Depositor seeds DAI debt liquidity.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    // Borrower posts WETH and borrows DAI near max (variable).
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '10');
    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');
    await pool.connect(borrower.signer).setUserUseReserveAsCollateral(weth.address, true);

    const accountData = await pool.getUserAccountData(borrower.address);
    const daiPrice0 = await oracle.getAssetPrice(dai.address);
    const toBorrow = await convertToCurrencyDecimals(
      dai.address,
      accountData.availableBorrowsBase.div(daiPrice0).percentMul(9500).toString()
    );
    await pool
      .connect(borrower.signer)
      .borrow(dai.address, toBorrow, RateMode.Variable, '0', borrower.address);

    // Accrue interest so the variable-debt index moves above RAY before the
    // loop (kit "Accruing interest": utilization + time + a state touch). The
    // index moving above RAY is what makes the directional rounding observable.
    await increaseTime(365 * 24 * 60 * 60);
    const borrowIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(borrowIndex).to.be.gt(RAY, 'variable borrow index must accrue above RAY');

    // Drop HF below 1.
    await waitForTx(await oracle.setAssetPrice(dai.address, daiPrice0.percentMul(11500)));
    expect((await pool.getUserAccountData(borrower.address)).healthFactor).to.be.lt(oneEther);

    // Liquidator funds DAI.
    const liquidatorBudget = await convertToCurrencyDecimals(dai.address, '100000');
    await dai.connect(liquidator.signer)['mint(uint256)'](liquidatorBudget);
    await dai.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT);

    const treasuryAddress = await aWETH.RESERVE_TREASURY_ADDRESS();
    const treasuryAColInitial = await aWETH.balanceOf(treasuryAddress);
    let liquidatorAColPrior = await aWETH.balanceOf(liquidator.address);
    let liquidatorDaiPrior = await dai.balanceOf(liquidator.address);

    // Small fixed per-call debt so each call nibbles at the position and the
    // protocol-fee transfer sees small scaled magnitudes (residue boundary).
    const K = 20;
    const debtPerCall = await convertToCurrencyDecimals(dai.address, '1');

    // +1s per iteration so the indexes keep drifting (deterministic).
    const startBlock = await hre.ethers.provider.getBlock('latest');
    let nextTimestamp = startBlock.timestamp;
    const setNextTs = async () => {
      nextTimestamp += 1;
      await hre.ethers.provider.send('evm_setNextBlockTimestamp', [nextTimestamp]);
    };

    const perIterDaiDeltas: BigNumber[] = [];
    const perIterAColDeltas: BigNumber[] = [];
    let totalLiquidations = 0;

    for (let i = 0; i < K; i++) {
      await setNextTs();

      const tx = await pool
        .connect(liquidator.signer)
        .liquidationCall(weth.address, dai.address, borrower.address, debtPerCall, false);
      const receipt = await waitForTx(tx);
      // No "ERC20: burn amount exceeds balance" dust-edge revert.
      expect(receipt.status).to.equal(1);
      totalLiquidations += 1;

      const liquidatorDaiNow = await dai.balanceOf(liquidator.address);
      perIterDaiDeltas.push(liquidatorDaiNow.sub(liquidatorDaiPrior));
      liquidatorDaiPrior = liquidatorDaiNow;

      // receiveAToken=false: the liquidator must NOT be credited collateral aTokens.
      const liquidatorAColNow = await aWETH.balanceOf(liquidator.address);
      perIterAColDeltas.push(liquidatorAColNow.sub(liquidatorAColPrior));
      liquidatorAColPrior = liquidatorAColNow;

      // Guard against an unintended full clear (would make per-call sizing wrong).
      const remainingDebt = await variableDebtDai.balanceOf(borrower.address);
      expect(remainingDebt).to.be.gt(0, `borrower debt fully cleared early at iteration ${i}`);
    }

    // Non-vacuous: all K iterations actually executed.
    expect(totalLiquidations).to.equal(
      K,
      `expected all K=${K} liquidations to succeed; only ${totalLiquidations} did`
    );

    // Per-iter debt-asset outflow is EXACTLY debtPerCall (no rounding leak on
    // the debt leg): the liquidator transfers debtPerCall DAI OUT each call,
    // so the delta is -debtPerCall.
    for (let i = 0; i < perIterDaiDeltas.length; i++) {
      expect(perIterDaiDeltas[i]).to.equal(
        debtPerCall.mul(-1),
        `iteration ${i}: per-iter DAI delta ${perIterDaiDeltas[
          i
        ].toString()} != -${debtPerCall.toString()} (debt-leg extraction)`
      );
    }

    // Per-iter collateral aToken delta to the liquidator is EXACTLY 0.
    for (let i = 0; i < perIterAColDeltas.length; i++) {
      expect(perIterAColDeltas[i]).to.equal(
        BigNumber.from(0),
        `iteration ${i}: receiveAToken=false must not credit collateral aTokens to the liquidator; got ${perIterAColDeltas[
          i
        ].toString()}`
      );
    }

    // Treasury collateral aToken balance strictly grew across the loop
    // (cumulative protocol-fee credit, rounding in the protocol's favor). A
    // baseline captured before the loop makes this non-tautological.
    const treasuryAColFinal = await aWETH.balanceOf(treasuryAddress);
    expect(treasuryAColFinal).to.be.gt(
      treasuryAColInitial,
      `treasury aWETH must strictly grow across K=${K} liquidations; pre=${treasuryAColInitial.toString()} post=${treasuryAColFinal.toString()}`
    );

    await evmRevert(loopSnap);
  });

  it('(c) dust under-water position is fully liquidatable (no burn-amount-exceeds-balance revert)', async () => {
    const {
      pool,
      users: [depositor, borrower, liquidator],
      dai,
      weth,
      variableDebtDai,
      aWETH,
      oracle,
      configurator,
      poolAdmin,
    } = testEnv;

    // Protocol fee enabled so the maxed-out path exercises the fee guard.
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setLiquidationProtocolFee(weth.address, 1000)
    );

    // Depositor seeds DAI.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    // Borrower posts a small WETH collateral and a dust DAI borrow.
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '0.05');
    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');
    await pool.connect(borrower.signer).setUserUseReserveAsCollateral(weth.address, true);

    const accountData = await pool.getUserAccountData(borrower.address);
    const daiPrice0 = await oracle.getAssetPrice(dai.address);
    const toBorrow = await convertToCurrencyDecimals(
      dai.address,
      accountData.availableBorrowsBase.div(daiPrice0).percentMul(9500).toString()
    );
    await pool
      .connect(borrower.signer)
      .borrow(dai.address, toBorrow, RateMode.Variable, '0', borrower.address);

    // Accrue interest so the indexes (and scaled balances) sit off RAY, which
    // is where the dust-edge burn revert used to surface.
    await increaseTime(365 * 24 * 60 * 60);
    const incomeIndex = await pool.getReserveNormalizedIncome(weth.address);
    const borrowIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(borrowIndex).to.be.gt(RAY, 'variable borrow index must accrue above RAY');

    // Push the position deeply under water (large debt-price bump) so the full
    // close factor applies and a maxed-out liquidation must drain dust collateral.
    await waitForTx(await oracle.setAssetPrice(dai.address, daiPrice0.mul(5)));
    expect((await pool.getUserAccountData(borrower.address)).healthFactor).to.be.lt(oneEther);

    // Liquidator funds DAI.
    const liquidatorBudget = await convertToCurrencyDecimals(dai.address, '100000');
    await dai.connect(liquidator.signer)['mint(uint256)'](liquidatorBudget);
    await dai.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT);

    const debtBefore = await variableDebtDai.balanceOf(borrower.address);
    const borrowerAColBefore = await aWETH.balanceOf(borrower.address);
    expect(debtBefore).to.be.gt(0);
    expect(borrowerAColBefore).to.be.gt(0);
    void incomeIndex;

    // Maxed-out liquidation: MUST NOT revert with "ERC20: burn amount exceeds
    // balance" (the dust-edge regression the patch closes).
    const tx = await pool
      .connect(liquidator.signer)
      .liquidationCall(weth.address, dai.address, borrower.address, MAX_UINT_AMOUNT, false);
    const receipt = await waitForTx(tx);
    expect(receipt.status).to.equal(1);

    // Non-vacuous: the borrower's debt strictly decreased and collateral was drained.
    const debtAfter = await variableDebtDai.balanceOf(borrower.address);
    const borrowerAColAfter = await aWETH.balanceOf(borrower.address);
    expect(debtAfter).to.be.lt(debtBefore, 'maxed-out liquidation must strictly reduce debt');
    expect(borrowerAColAfter).to.be.lt(
      borrowerAColBefore,
      'maxed-out liquidation must strictly reduce borrower collateral'
    );
  });

  it('(d) clears the collateral flag when receiveAToken liquidation drains scaled collateral with a strict-partial amount', async () => {
    const {
      pool,
      users: [wethDepositor, wethBorrower, borrower, liquidator],
      dai,
      weth,
      aWETH,
      variableDebtDai,
      oracle,
      helpersContract,
      configurator,
      poolAdmin,
    } = testEnv;

    await waitForTx(
      await configurator.connect(poolAdmin.signer).setLiquidationProtocolFee(weth.address, 0)
    );

    // First drift the WETH liquidity index and then repay the WETH debt so the
    // collateral index is pinned before the ceil-quantum probe.
    const wethLiquidity = await convertToCurrencyDecimals(weth.address, '100');
    await waitForTx(
      await weth
        .connect(wethDepositor.signer)
        ['mint(address,uint256)'](wethDepositor.address, wethLiquidity)
    );
    await waitForTx(
      await weth.connect(wethDepositor.signer).approve(pool.address, MAX_UINT_AMOUNT)
    );
    await waitForTx(
      await pool
        .connect(wethDepositor.signer)
        .supply(weth.address, wethLiquidity, wethDepositor.address, '0')
    );

    const daiCollateralForWethBorrow = await convertToCurrencyDecimals(dai.address, '500000');
    await waitForTx(
      await dai.connect(wethBorrower.signer)['mint(uint256)'](daiCollateralForWethBorrow)
    );
    await waitForTx(await dai.connect(wethBorrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(wethBorrower.signer)
        .supply(dai.address, daiCollateralForWethBorrow, wethBorrower.address, '0')
    );

    const wethBorrow = wethLiquidity.percentMul(9000);
    await waitForTx(
      await pool
        .connect(wethBorrower.signer)
        .borrow(weth.address, wethBorrow, RateMode.Variable, '0', wethBorrower.address)
    );
    await increaseTime(60 * 365 * 24 * 60 * 60);

    const wethReserve = await pool.getReserveData(weth.address);
    const variableDebtWeth = await hre.ethers.getContractAt(
      'VariableDebtToken',
      wethReserve.variableDebtTokenAddress
    );
    const wethDebt = await variableDebtWeth.balanceOf(wethBorrower.address);
    await waitForTx(
      await weth
        .connect(wethBorrower.signer)
        ['mint(address,uint256)'](wethBorrower.address, wethDebt.mul(2))
    );
    await waitForTx(await weth.connect(wethBorrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(wethBorrower.signer)
        .repay(weth.address, MAX_UINT_AMOUNT, RateMode.Variable, wethBorrower.address)
    );

    const collateralIndex = await pool.getReserveNormalizedIncome(weth.address);
    expect(collateralIndex).to.be.gt(
      RAY.mul(2),
      'WETH liquidity index must exceed 2*RAY for a strict-partial drain'
    );
    expect(collateralIndex).to.eq(
      (await pool.getReserveData(weth.address)).liquidityIndex,
      'WETH index must be pinned before computing the strict-partial drain'
    );

    // Now create the actual liquidation position: WETH collateral, DAI debt.
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    await waitForTx(await dai.connect(wethDepositor.signer)['mint(uint256)'](daiLiquidity));
    await waitForTx(await dai.connect(wethDepositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(wethDepositor.signer)
        .supply(dai.address, daiLiquidity, wethDepositor.address, '0')
    );

    const borrowerCollateral = await convertToCurrencyDecimals(weth.address, '0.01');
    await waitForTx(
      await weth
        .connect(borrower.signer)
        ['mint(address,uint256)'](borrower.address, borrowerCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .supply(weth.address, borrowerCollateral, borrower.address, '0')
    );

    expect(await collateralBit(borrower.address, weth.address)).to.eq(
      1,
      'borrower starts with WETH collateral enabled'
    );

    const daiPrice0 = await oracle.getAssetPrice(dai.address);
    await waitForTx(await oracle.setAssetPrice(dai.address, daiPrice0.percentMul(5000)));

    const accountData = await pool.getUserAccountData(borrower.address);
    const borrowPrice = await oracle.getAssetPrice(dai.address);
    const toBorrow = await convertToCurrencyDecimals(
      dai.address,
      accountData.availableBorrowsBase.div(borrowPrice).percentMul(9500).toString()
    );
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, toBorrow, RateMode.Variable, '0', borrower.address)
    );

    await waitForTx(await oracle.setAssetPrice(dai.address, daiPrice0.percentMul(20000)));
    expect((await pool.getUserAccountData(borrower.address)).healthFactor).to.be.lt(oneEther);

    const scaledBalance = await aWETH.scaledBalanceOf(borrower.address);
    const userBalance = await aWETH.balanceOf(borrower.address);
    expect(scaledBalance).to.be.gt(0);
    expect(userBalance).to.be.gt(0);

    let drainAmount: BigNumber | null = null;
    const lowerBound = scaledBalance.sub(1).mul(collateralIndex).div(RAY);
    for (let probe = 1; probe <= 8192; probe++) {
      const candidate = lowerBound.add(probe);
      if (candidate.gte(userBalance)) break;
      if (rayDivCeil(candidate, collateralIndex).eq(scaledBalance)) {
        drainAmount = candidate;
        break;
      }
    }
    if (drainAmount === null) {
      throw new Error(
        `no strict-partial liquidation collateral amount drains scaled balance; idx=${collateralIndex.toString()} scaled=${scaledBalance.toString()} balance=${userBalance.toString()}`
      );
    }

    const wethConfig = await helpersContract.getReserveConfigurationData(weth.address);
    const daiConfig = await helpersContract.getReserveConfigurationData(dai.address);
    const liquidationBonus = BigNumber.from(wethConfig.liquidationBonus);
    const collateralUnit = BigNumber.from(10).pow(BigNumber.from(wethConfig.decimals));
    const debtUnit = BigNumber.from(10).pow(BigNumber.from(daiConfig.decimals));
    const collateralPrice = await oracle.getAssetPrice(weth.address);
    const debtPrice = await oracle.getAssetPrice(dai.address);

    const expectedCollateralFor = (debtToCover: BigNumber) => {
      const baseCollateral = debtPrice
        .mul(debtToCover)
        .mul(collateralUnit)
        .div(collateralPrice.mul(debtUnit));
      return percentMulFloor(baseCollateral, liquidationBonus);
    };

    const baseDebt = ceilDiv(
      percentDivCeil(drainAmount, liquidationBonus).mul(collateralPrice).mul(debtUnit),
      debtPrice.mul(collateralUnit)
    );
    let debtToCover: BigNumber | null = null;
    for (let offset = 0; offset <= 200000; offset++) {
      const candidates =
        offset === 0
          ? [baseDebt]
          : [baseDebt.add(offset), baseDebt.gt(offset) ? baseDebt.sub(offset) : BigNumber.from(0)];
      for (const candidate of candidates) {
        if (candidate.isZero()) continue;
        const expectedCollateral = expectedCollateralFor(candidate);
        if (
          expectedCollateral.lt(userBalance) &&
          rayDivCeil(expectedCollateral, collateralIndex).eq(scaledBalance)
        ) {
          debtToCover = candidate;
          drainAmount = expectedCollateral;
          break;
        }
      }
      if (debtToCover !== null) break;
    }
    if (debtToCover === null) {
      throw new Error(
        `no DAI debtToCover maps to a strict-partial WETH scaled drain near ${baseDebt.toString()}`
      );
    }

    const currentDebt = await variableDebtDai.balanceOf(borrower.address);
    expect(debtToCover).to.be.lt(
      currentDebt,
      'debtToCover must fit inside the full close-factor cap'
    );

    await waitForTx(await dai.connect(liquidator.signer)['mint(uint256)'](debtToCover.mul(2)));
    await waitForTx(await dai.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT));

    await waitForTx(
      await pool
        .connect(liquidator.signer)
        .liquidationCall(weth.address, dai.address, borrower.address, debtToCover, true)
    );

    expect(await aWETH.scaledBalanceOf(borrower.address)).to.eq(
      0,
      'liquidation must drain borrower scaled collateral'
    );
    expect(await collateralBit(borrower.address, weth.address)).to.eq(
      0,
      `collateral flag must clear after strict-partial liquidation drain amount=${drainAmount!.toString()} balance=${userBalance.toString()}`
    );
  });

  it('(e) keeps same-asset liquidation rates aligned with the post-action reserve state', async () => {
    const {
      pool,
      users: [depositor, borrower, liquidator],
      weth,
      oracle,
      helpersContract,
    } = testEnv;

    const depositorLiquidity = await convertToCurrencyDecimals(weth.address, '10');
    await waitForTx(
      await weth
        .connect(depositor.signer)
        ['mint(address,uint256)'](depositor.address, depositorLiquidity)
    );
    await waitForTx(await weth.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(depositor.signer)
        .supply(weth.address, depositorLiquidity, depositor.address, '0')
    );

    const borrowerCollateral = await convertToCurrencyDecimals(weth.address, '10');
    await waitForTx(
      await weth
        .connect(borrower.signer)
        ['mint(address,uint256)'](borrower.address, borrowerCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .supply(weth.address, borrowerCollateral, borrower.address, '0')
    );

    const accountData = await pool.getUserAccountData(borrower.address);
    const wethConfig = await helpersContract.getReserveConfigurationData(weth.address);
    const wethPrice = await oracle.getAssetPrice(weth.address);
    const toBorrow = await convertToCurrencyDecimals(
      weth.address,
      accountData.availableBorrowsBase.div(wethPrice).percentMul(9900).toString()
    );
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(weth.address, toBorrow, RateMode.Variable, '0', borrower.address)
    );

    await increaseTime(365 * 24 * 60 * 60);
    expect((await pool.getUserAccountData(borrower.address)).healthFactor).to.be.lt(oneEther);

    const reserveBefore = await pool.getReserveData(weth.address);
    const variableDebtToken = await hre.ethers.getContractAt(
      'VariableDebtToken',
      reserveBefore.variableDebtTokenAddress
    );
    const debtBefore = await variableDebtToken.balanceOf(borrower.address);
    await waitForTx(
      await weth.connect(liquidator.signer)['mint(address,uint256)'](liquidator.address, debtBefore)
    );
    await waitForTx(await weth.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT));

    const receipt = await waitForTx(
      await pool
        .connect(liquidator.signer)
        .liquidationCall(weth.address, weth.address, borrower.address, MAX_UINT_AMOUNT, false)
    );

    const liquidationIface = new utils.Interface(LIQUIDATION_CALL_IFACE);
    const liquidationEvent = receipt.logs
      .map((log) => {
        try {
          return liquidationIface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event?.name === 'LiquidationCall');
    expect(liquidationEvent, 'LiquidationCall event must be emitted').to.not.eq(undefined);
    expect(liquidationEvent!.args.debtToCover).to.be.gt(0);
    expect(liquidationEvent!.args.liquidatedCollateralAmount).to.be.gt(0);

    const reserveAfter = await pool.getReserveData(weth.address);
    const strategy = DefaultReserveInterestRateStrategy__factory.connect(
      reserveAfter.interestRateStrategyAddress,
      liquidator.signer
    );
    const stableDebtToken = IStableDebtToken__factory.connect(
      reserveAfter.stableDebtTokenAddress,
      liquidator.signer
    );
    const stableDebtData = await stableDebtToken.getSupplyData();

    const expectedRates = await strategy.calculateInterestRates({
      unbacked: reserveAfter.unbacked,
      liquidityAdded: 0,
      liquidityTaken: 0,
      totalStableDebt: stableDebtData[1],
      totalVariableDebt: await variableDebtToken.totalSupply(),
      averageStableBorrowRate: stableDebtData[2],
      reserveFactor: wethConfig.reserveFactor,
      reserve: weth.address,
      aToken: reserveAfter.aTokenAddress,
    });

    expect(reserveAfter.currentLiquidityRate).to.eq(expectedRates[0]);
    expect(reserveAfter.currentStableBorrowRate).to.eq(expectedRates[1]);
    expect(reserveAfter.currentVariableBorrowRate).to.eq(expectedRates[2]);
  });

  it('(f) caps repay debt with percentDivCeil when collateral is the limiting side', async () => {
    const {
      pool,
      users: [depositor, borrower, liquidator],
      dai,
      weth,
      aWETH,
      variableDebtDai,
      oracle,
      helpersContract,
      configurator,
      poolAdmin,
    } = testEnv;

    await waitForTx(
      await configurator.connect(poolAdmin.signer).setLiquidationProtocolFee(weth.address, 0)
    );

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0')
    );

    const wethCollateral = await convertToCurrencyDecimals(weth.address, '1');
    await waitForTx(
      await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .supply(weth.address, wethCollateral, borrower.address, '0')
    );

    const accountData = await pool.getUserAccountData(borrower.address);
    const daiPrice0 = await oracle.getAssetPrice(dai.address);
    const toBorrow = await convertToCurrencyDecimals(
      dai.address,
      accountData.availableBorrowsBase.div(daiPrice0).percentMul(9500).toString()
    );
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, toBorrow, RateMode.Variable, '0', borrower.address)
    );

    const wethConfig = await helpersContract.getReserveConfigurationData(weth.address);
    const daiConfig = await helpersContract.getReserveConfigurationData(dai.address);
    const liquidationBonus = BigNumber.from(wethConfig.liquidationBonus);
    const collateralUnit = BigNumber.from(10).pow(BigNumber.from(wethConfig.decimals));
    const debtUnit = BigNumber.from(10).pow(BigNumber.from(daiConfig.decimals));
    const collateralPrice = await oracle.getAssetPrice(weth.address);
    const userCollateralBalance = await aWETH.balanceOf(borrower.address);
    const userDebt = await variableDebtDai.balanceOf(borrower.address);

    let chosenDebtPrice: BigNumber | null = null;
    let expectedDebtNeeded: BigNumber | null = null;
    let halfUpDebtNeeded: BigNumber | null = null;

    for (let multiplier = 2; multiplier <= 12 && chosenDebtPrice === null; multiplier++) {
      for (let offset = 1; offset <= 2000; offset++) {
        const debtPrice = daiPrice0.mul(multiplier).add(offset);
        const rawDebt = collateralPrice
          .mul(userCollateralBalance)
          .mul(debtUnit)
          .div(debtPrice.mul(collateralUnit));
        const ceilDebt = percentDivCeil(rawDebt, liquidationBonus);
        const halfUpDebt = percentDivHalfUp(rawDebt, liquidationBonus);

        if (ceilDebt.gt(halfUpDebt) && ceilDebt.gt(0) && ceilDebt.lt(userDebt)) {
          chosenDebtPrice = debtPrice;
          expectedDebtNeeded = ceilDebt;
          halfUpDebtNeeded = halfUpDebt;
          break;
        }
      }
    }

    if (chosenDebtPrice === null || expectedDebtNeeded === null || halfUpDebtNeeded === null) {
      throw new Error('no collateral-capped percentDivCeil residue found');
    }

    await waitForTx(await oracle.setAssetPrice(dai.address, chosenDebtPrice));
    expect((await pool.getUserAccountData(borrower.address)).healthFactor).to.be.lt(oneEther);

    await waitForTx(
      await dai.connect(liquidator.signer)['mint(uint256)'](expectedDebtNeeded.mul(2))
    );
    await waitForTx(await dai.connect(liquidator.signer).approve(pool.address, MAX_UINT_AMOUNT));

    const receipt = await waitForTx(
      await pool
        .connect(liquidator.signer)
        .liquidationCall(weth.address, dai.address, borrower.address, MAX_UINT_AMOUNT, false)
    );

    const liquidationIface = new utils.Interface(LIQUIDATION_CALL_IFACE);
    const liquidationEvent = receipt.logs
      .map((log) => {
        try {
          return liquidationIface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event?.name === 'LiquidationCall');

    expect(liquidationEvent, 'LiquidationCall event must be emitted').to.not.eq(undefined);
    expect(liquidationEvent!.args.debtToCover).to.eq(
      expectedDebtNeeded,
      'collateral-capped branch must repay percentDivCeil debtAmountNeeded'
    );
    expect(liquidationEvent!.args.debtToCover).to.be.gt(
      halfUpDebtNeeded,
      'test premise must distinguish ceil from half-up'
    );
    expect(liquidationEvent!.args.liquidatedCollateralAmount).to.eq(userCollateralBalance);
  });
});
