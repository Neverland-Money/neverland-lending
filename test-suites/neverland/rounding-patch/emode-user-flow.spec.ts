/*
 * eMode user-flow boundary regression on the patched LENDING stack.
 *
 * Re-expresses the POOL-repo `tests/rounding/emode-user-flow.spec.ts`
 * scenarios on the LENDING `makeSuite` harness (real Pool, patched
 * ATokenPEV3 / VariableDebtTokenPEV2, variable rate only). The POOL
 * spec self-deploys a WBTC/USDC/ALT market; here we drive the
 * pre-listed DAI / USDC / WETH / AAVE reserves and move prices through
 * the mutable PriceOracle (the AaveOracle's MockAggregator has no
 * setter), restoring the AaveOracle in `after()`.
 *
 * Asset role map (all variable rate):
 *   - DAI  (18 dec, standalone LTV 7500 / LT 8000): IN-category collateral.
 *   - USDC (6 dec,  standalone LTV 8000 / LT 8500): IN-category borrow asset.
 *   - WETH (18 dec): NOT in the category; used purely as the eMode
 *     `priceSource` ADDRESS so we can move the eMode oracle price
 *     independently of the DAI/USDC standalone prices.
 *   - AAVE (18 dec, standalone LTV 5000 / LT 6500): OUT-of-category
 *     collateral, used to prove per-asset eMode price gating.
 *
 * What is proven end-to-end against the patched runtime:
 *   (a) Entering eMode re-prices `totalCollateralBase` to the eMode
 *       priceSource oracle and flips `ltv` / `currentLiquidationThreshold`
 *       to the category values for in-category collateral.
 *   (b) ENTER is HF-validated after the price-source replacement:
 *       setUserEMode(1) reverts '35' when the projected in-eMode HF < 1,
 *       and the userEModeCategory storage write is reverted (state
 *       unchanged).
 *   (c) EXIT is HF-validated under standalone LT: setUserEMode(0)
 *       reverts '35' when the standalone-LT HF would drop below 1,
 *       state unchanged; the symmetric EXIT succeeds when standalone-LT
 *       HF stays >= 1 and collapses ltv/LT back to standalone.
 *   (d) An active eMode user cannot borrow an out-of-category asset
 *       ('58'); debt is unchanged.
 *   (e) The eMode price replacement fires only for in-category assets;
 *       out-of-category collateral keeps its standalone oracle price.
 *
 * Non-vacuity: every `it` asserts a positive observable effect (a
 * re-priced collateral total equal to an independently computed value,
 * a flipped ltv/LT, an unchanged-on-revert eMode category, a strictly
 * positive debt, or a liquidity index strictly above RAY) so a silent
 * early-revert cannot pass.
 */

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { getVariableDebtToken } from '@aave/deploy-v3/dist/helpers/contract-getters';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS, oneEther } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import '../../helpers/utils/wadraymath';

makeSuite('Neverland rounding patch: eMode user flow', (testEnv: TestEnv) => {
  const { HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD, INCONSISTENT_EMODE_CATEGORY } =
    ProtocolErrors;

  const RAY = BigNumber.from(10).pow(27);

  // eMode category #1: elevated vs the in-category assets' standalone
  // params. DAI standalone is LTV 7500 / LT 8000 and USDC is 8000 / 8500,
  // so the category LTV/LT must be >= the max in-category standalone
  // value (validateSetEModeCategoryParams). 9000 / 9500 satisfies that.
  const EMODE_ID = 1;
  const EMODE_LTV = BigNumber.from(9000);
  const EMODE_LT = BigNumber.from(9500);
  const EMODE_LB = BigNumber.from(10100);
  const EMODE_LABEL = 'DAI-USDC-Correlated';

  // DAI standalone risk params (test market), used to compute the
  // standalone-LT HF boundary for the EXIT guard.
  const DAI_STANDALONE_LTV = BigNumber.from(7500);
  const DAI_STANDALONE_LT = BigNumber.from(8000);

  let snap: string;

  before(async () => {
    const { addressesProvider, oracle } = testEnv;
    // Route HF math through the mutable PriceOracle (pre-seeded with the
    // AaveOracle prices in initializeMakeSuite). setAssetPrice on this
    // oracle then moves the eMode priceSource / asset prices at will.
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

  // Configure category #1 with the given price source and bind DAI + USDC
  // to it. WETH and AAVE deliberately stay out of the category.
  const configureCategory = async (priceSource: string) => {
    const { configurator, poolAdmin, dai, usdc } = testEnv;
    await waitForTx(
      await configurator
        .connect(poolAdmin.signer)
        .setEModeCategory(EMODE_ID, EMODE_LTV, EMODE_LT, EMODE_LB, priceSource, EMODE_LABEL)
    );
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setAssetEModeCategory(dai.address, EMODE_ID)
    );
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setAssetEModeCategory(usdc.address, EMODE_ID)
    );
  };

  const mintApproveSupply = async (
    token: any,
    user: { address: string; signer: any },
    units: string
  ) => {
    const { pool } = testEnv;
    const amount = await convertToCurrencyDecimals(token.address, units);
    await waitForTx(
      await token.connect(user.signer)['mint(address,uint256)'](user.address, amount)
    );
    await waitForTx(await token.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(user.signer).supply(token.address, amount, user.address, '0')
    );
    return amount;
  };

  it('(a) entering eMode re-prices totalCollateralBase to the priceSource oracle and flips ltv/LT', async () => {
    const {
      pool,
      dai,
      usdc,
      weth,
      oracle,
      users: [depositor, user],
    } = testEnv;

    // Use WETH's address as the category price source. Crucially WETH is
    // NOT in the category, so moving its price does not touch the DAI/USDC
    // standalone valuations; it only re-prices in-category collateral via
    // the eMode oracle replacement.
    await configureCategory(weth.address);

    // Seed USDC liquidity so the user could borrow later (not required for
    // the re-price assertion, but keeps the flow realistic).
    await mintApproveSupply(usdc, depositor, '1000000');

    // User supplies DAI as collateral.
    const daiSupply = await mintApproveSupply(dai, user, '10000');

    // Pin the eMode oracle price to a value distinct from DAI's standalone
    // price so the re-price is observable. Standalone DAI ~ $1 (1e8 base);
    // set the WETH priceSource to $2 (2e8 base) so in-eMode DAI collateral
    // doubles in base-currency value.
    const daiStandalonePrice = await oracle.getAssetPrice(dai.address);
    const eModePrice = daiStandalonePrice.mul(2);
    await waitForTx(await oracle.setAssetPrice(weth.address, eModePrice));

    // Standalone collateral base = daiSupply * daiStandalonePrice / 1e18.
    const standaloneData = await pool.getUserAccountData(user.address);
    const daiUnit = BigNumber.from(10).pow(18);
    const expectedStandaloneBase = daiSupply.mul(daiStandalonePrice).div(daiUnit);
    expect(standaloneData.totalCollateralBase).to.eq(
      expectedStandaloneBase,
      'before eMode: collateral must price at the standalone DAI oracle'
    );
    // Standalone ltv/LT must equal DAI's per-reserve config.
    expect(standaloneData.ltv).to.eq(DAI_STANDALONE_LTV);
    expect(standaloneData.currentLiquidationThreshold).to.eq(DAI_STANDALONE_LT);

    // Enter eMode #1.
    await waitForTx(await pool.connect(user.signer).setUserEMode(EMODE_ID));
    expect(await pool.getUserEMode(user.address)).to.eq(EMODE_ID);
    expect((await pool.getEModeCategoryData(EMODE_ID)).priceSource).to.eq(weth.address);

    // After entering eMode, DAI collateral must re-price at the eMode
    // oracle (the WETH priceSource = $2), so the base total doubles.
    const eModeData = await pool.getUserAccountData(user.address);
    const expectedEModeBase = daiSupply.mul(eModePrice).div(daiUnit);
    expect(eModeData.totalCollateralBase).to.eq(
      expectedEModeBase,
      'after eMode: collateral must price at the eMode priceSource oracle'
    );
    // Positive, observable re-price: collateral strictly grew.
    expect(eModeData.totalCollateralBase).to.be.gt(standaloneData.totalCollateralBase);
    // ltv / LT flip to the category values.
    expect(eModeData.ltv).to.eq(EMODE_LTV, 'eMode LTV must replace the standalone DAI LTV');
    expect(eModeData.currentLiquidationThreshold).to.eq(
      EMODE_LT,
      'eMode LT must replace the standalone DAI LT'
    );
  });

  it('(b) ENTER is HF-validated after the price-source replacement (reverts 35; state unchanged)', async () => {
    const {
      pool,
      usdc,
      weth,
      aave,
      configurator,
      poolAdmin,
      oracle,
      users: [depositor, user],
    } = testEnv;

    // Dedicated category for this case: WETH (collateral) + USDC (debt),
    // priceSource = AAVE (an already-listed, OUT-of-category asset with a
    // non-zero seeded price). Both WETH and USDC standalone LTV is 8000, so
    // the category LTV 9000 / LT 9500 satisfies validateSetEModeCategoryParams.
    //
    // The ENTER-side guard exploits the standalone price asymmetry exactly
    // as the POOL (b4b) case does: outside eMode, WETH (~$thousands) and
    // USDC (~$1) have very different per-unit prices, so 1 USDC of debt is
    // trivially collateralised by WETH. Once the eMode price source is
    // applied, BOTH in-category assets are valued at the SAME per-asset-unit
    // price (the AAVE oracle), flattening the ratio: 1 WETH collateral and
    // 1 USDC debt become equal in base currency. The projected in-eMode HF
    // is then ~ LT (0.95) < 1, so setUserEMode must revert from the
    // validateHFAndLtv ENTER guard.
    await waitForTx(
      await configurator
        .connect(poolAdmin.signer)
        .setEModeCategory(EMODE_ID, EMODE_LTV, EMODE_LT, EMODE_LB, aave.address, EMODE_LABEL)
    );
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setAssetEModeCategory(weth.address, EMODE_ID)
    );
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setAssetEModeCategory(usdc.address, EMODE_ID)
    );
    expect((await pool.getEModeCategoryData(EMODE_ID)).priceSource).to.eq(aave.address);
    // priceSource oracle must be non-zero for the flattening to apply.
    expect(await oracle.getAssetPrice(aave.address)).to.be.gt(0);

    // Seed USDC liquidity for the user's tiny standalone borrow.
    await mintApproveSupply(usdc, depositor, '1000000');

    // User supplies 1 WETH and borrows a tiny 1 USDC while OUTSIDE eMode.
    await mintApproveSupply(weth, user, '1');
    const tinyUsdc = await convertToCurrencyDecimals(usdc.address, '1');
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(usdc.address, tinyUsdc, RateMode.Variable, '0', user.address)
    );

    // Positive precondition: standalone HF is healthy and debt exists.
    const before = await pool.getUserAccountData(user.address);
    expect(before.totalDebtBase).to.be.gt(0, 'borrow must have credited variable debt');
    expect(before.healthFactor).to.be.gt(oneEther, 'standalone HF must start above 1 WAD');

    // ENTER must revert from validateHFAndLtv after the price-source
    // replacement (HF ~ 0.95 < 1).
    await expect(pool.connect(user.signer).setUserEMode(EMODE_ID)).to.be.revertedWith(
      HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD
    );

    // State unchanged: the userEModeCategory write reverted with the require.
    expect(await pool.getUserEMode(user.address)).to.eq(
      0,
      'failed setUserEMode(1) must revert the category write'
    );
    // And the account still values at its standalone oracle (WETH LTV 8000),
    // unchanged from before the failed enter.
    const after = await pool.getUserAccountData(user.address);
    expect(after.totalCollateralBase).to.eq(before.totalCollateralBase);
    expect(after.ltv).to.eq(
      BigNumber.from(8000),
      'WETH standalone LTV must be intact after revert'
    );
  });

  it('(c1) EXIT reverts 35 when standalone-LT HF would drop below 1 (state unchanged)', async () => {
    const {
      pool,
      dai,
      usdc,
      users: [depositor, user],
    } = testEnv;

    // priceSource = ZERO so each asset keeps its standalone oracle. This
    // isolates the LTV/LT elevation as the only thing expanding capacity
    // inside eMode and lets us straddle the standalone-LT boundary.
    await configureCategory(ZERO_ADDRESS);

    await mintApproveSupply(usdc, depositor, '1000000');

    // User supplies $10,000 DAI and enters eMode. Standalone-LT capacity
    // (LT 8000) for HF >= 1 is collateralBase * 0.80. Inside eMode the
    // elevated LTV (9000) / LT (9500) lets the user borrow past that
    // standalone-LT line while keeping in-eMode HF > 1.
    const daiSupply = await mintApproveSupply(dai, user, '10000');
    await waitForTx(await pool.connect(user.signer).setUserEMode(EMODE_ID));

    // Read the collateral base inside eMode and size a USDC borrow whose
    // base value sits between the standalone-LT line (0.80 * collateral)
    // and the eMode-LT line (0.95 * collateral). 0.85 * collateral lands
    // in that band: standalone-LT HF ~ 0.94 (< 1), eMode-LT HF ~ 1.12.
    const inEMode0 = await pool.getUserAccountData(user.address);
    const usdcPrice = await testEnv.oracle.getAssetPrice(usdc.address);
    const usdcUnit = BigNumber.from(10).pow(6);
    // targetDebtBase = collateralBase * 85%
    const targetDebtBase = inEMode0.totalCollateralBase.mul(85).div(100);
    // usdc underlying = targetDebtBase * usdcUnit / usdcPrice
    const borrowUsdc = targetDebtBase.mul(usdcUnit).div(usdcPrice);
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(usdc.address, borrowUsdc, RateMode.Variable, '0', user.address)
    );

    // Positive precondition: inside eMode HF is healthy and debt exists.
    const inEMode = await pool.getUserAccountData(user.address);
    expect(inEMode.totalDebtBase).to.be.gt(0, 'borrow must have credited debt');
    expect(inEMode.healthFactor).to.be.gt(
      oneEther,
      'inside eMode HF must be above 1 WAD (borrow itself does not trip a guard)'
    );

    // Independently project the standalone-LT HF the EXIT transition will
    // re-validate (userEModeCategory => 0 => DAI standalone LT 8000), and
    // assert it is strictly below 1 WAD so the guard is genuinely exercised.
    const projectedStandaloneHf = inEMode.totalCollateralBase
      .mul(DAI_STANDALONE_LT)
      .div(10000)
      .mul(oneEther)
      .div(inEMode.totalDebtBase);
    expect(projectedStandaloneHf).to.be.lt(
      oneEther,
      'projected standalone-LT HF must be < 1 WAD for the EXIT guard to fire'
    );

    // EXIT must revert from validateHealthFactor inside executeSetUserEMode.
    await expect(pool.connect(user.signer).setUserEMode(0)).to.be.revertedWith(
      HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD
    );

    // State unchanged: still inside the category, ltv/LT still eMode values.
    expect(await pool.getUserEMode(user.address)).to.eq(
      EMODE_ID,
      'failed setUserEMode(0) must revert the category write; user stays in eMode'
    );
    const stillIn = await pool.getUserAccountData(user.address);
    expect(stillIn.ltv).to.eq(EMODE_LTV);
    expect(stillIn.currentLiquidationThreshold).to.eq(EMODE_LT);
    expect(daiSupply).to.be.gt(0);
  });

  it('(c2) EXIT succeeds when standalone-LT HF stays >= 1 and collapses ltv/LT to standalone', async () => {
    const {
      pool,
      dai,
      usdc,
      users: [depositor, user],
    } = testEnv;

    await configureCategory(ZERO_ADDRESS);
    await mintApproveSupply(usdc, depositor, '1000000');

    // Supply $10,000 DAI, enter eMode, borrow well within the standalone
    // LTV cap (7500 => $7,500) so standalone-LT HF stays comfortably > 1
    // after exit. Borrow $4,000 USDC.
    await mintApproveSupply(dai, user, '10000');
    await waitForTx(await pool.connect(user.signer).setUserEMode(EMODE_ID));
    const borrowUsdc = await convertToCurrencyDecimals(usdc.address, '4000');
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(usdc.address, borrowUsdc, RateMode.Variable, '0', user.address)
    );

    // Inside eMode: ltv/LT are the elevated category values.
    const inEMode = await pool.getUserAccountData(user.address);
    expect(inEMode.ltv).to.eq(EMODE_LTV);
    expect(inEMode.currentLiquidationThreshold).to.eq(EMODE_LT);
    expect(inEMode.totalDebtBase).to.be.gt(0);

    // EXIT succeeds: standalone-LT HF = collateral * 0.80 / debt is well
    // above 1 for $8,000 LT capacity vs $4,000 debt.
    await waitForTx(await pool.connect(user.signer).setUserEMode(0));
    expect(await pool.getUserEMode(user.address)).to.eq(0, 'exit must report category 0');

    // Post-exit, ltv/LT collapse to DAI standalone, collateral re-prices at
    // the standalone oracle, and HF stays above 1.
    const after = await pool.getUserAccountData(user.address);
    expect(after.ltv).to.eq(
      DAI_STANDALONE_LTV,
      'post-exit ltv must collapse to standalone DAI LTV'
    );
    expect(after.currentLiquidationThreshold).to.eq(
      DAI_STANDALONE_LT,
      'post-exit LT must collapse to standalone DAI LT'
    );
    expect(after.healthFactor).to.be.gt(oneEther, 'post-exit HF must remain above 1 WAD');

    // A top-up that exceeds the standalone-LTV cap ($7,500) but was inside
    // the eMode cap ($9,000) is now rejected by the LTV projection ('36'),
    // proving capacity actually collapsed post-exit. We already owe $4,000;
    // adding $5,000 would lift the total to $9,000 > $7,500 cap.
    const overStandalone = await convertToCurrencyDecimals(usdc.address, '5000');
    await expect(
      pool
        .connect(user.signer)
        .borrow(usdc.address, overStandalone, RateMode.Variable, '0', user.address)
    ).to.be.revertedWith(ProtocolErrors.COLLATERAL_CANNOT_COVER_NEW_BORROW);

    // A small top-up inside the standalone cap ($4,000 + $2,000 = $6,000 <
    // $7,500) still succeeds, so the rejection is the LTV guard, not a
    // blanket block.
    const safeTopUp = await convertToCurrencyDecimals(usdc.address, '2000');
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(usdc.address, safeTopUp, RateMode.Variable, '0', user.address)
    );
    const final = await pool.getUserAccountData(user.address);
    expect(final.totalDebtBase).to.be.gt(inEMode.totalDebtBase, 'safe top-up must increase debt');
  });

  it('(d) active eMode user cannot borrow an out-of-category asset (reverts 58; debt unchanged)', async () => {
    const {
      pool,
      dai,
      usdc,
      weth,
      helpersContract,
      users: [depositor, user],
    } = testEnv;

    await configureCategory(ZERO_ADDRESS);

    // Seed liquidity in both the in-category USDC and the out-of-category
    // WETH so the only thing gating the WETH borrow is the eMode category.
    await mintApproveSupply(usdc, depositor, '1000000');
    await mintApproveSupply(weth, depositor, '100');

    // User supplies DAI collateral and enters eMode.
    await mintApproveSupply(dai, user, '10000');
    await waitForTx(await pool.connect(user.signer).setUserEMode(EMODE_ID));
    expect(await pool.getUserEMode(user.address)).to.eq(EMODE_ID);

    // Sanity: an in-category USDC borrow IS allowed (proves liquidity and
    // collateral suffice, so a later WETH revert is due to category gating).
    const okBorrow = await convertToCurrencyDecimals(usdc.address, '1000');
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(usdc.address, okBorrow, RateMode.Variable, '0', user.address)
    );
    const debtAfterUsdc = (await pool.getUserAccountData(user.address)).totalDebtBase;
    expect(debtAfterUsdc).to.be.gt(0, 'in-category borrow must credit debt');

    // The rejected borrow targets the OUT-of-category WETH reserve, so grab
    // its variable-debt token to observe whether the attempt minted any new
    // scaled debt. We compare SCALED debt (index-invariant) rather than
    // balanceOf / totalDebtBase: the reverting borrow still mines a block and
    // advances time ~1s, so the user's outstanding USDC debt accrues a few
    // wei of interest in between the reads. Scaled debt is immune to that and
    // makes the "no new debt was created" invariant exact.
    const { variableDebtTokenAddress: wethVDebtAddress } =
      await helpersContract.getReserveTokensAddresses(weth.address);
    const variableDebtWeth = await getVariableDebtToken(wethVDebtAddress);
    const wethScaledBefore = await variableDebtWeth.scaledBalanceOf(user.address);
    // Non-vacuity: the user enters the rejected borrow with no WETH debt, so
    // the only way scaled debt could change is the borrow actually opening a
    // position. (USDC debt > 0 above already proves the borrow path is live.)
    expect(wethScaledBefore).to.eq(0, 'user must start with no out-of-category WETH debt');

    // Borrowing WETH (NOT in the user's category) must revert 58.
    const wethBorrow = await convertToCurrencyDecimals(weth.address, '0.1');
    await expect(
      pool
        .connect(user.signer)
        .borrow(weth.address, wethBorrow, RateMode.Variable, '0', user.address)
    ).to.be.revertedWith(INCONSISTENT_EMODE_CATEGORY);

    // A reverted borrow mints no new scaled debt: the out-of-category position
    // was never opened. Exact and immune to the ~1s of interest the reverting
    // tx accrues on the pre-existing USDC debt.
    const wethScaledAfter = await variableDebtWeth.scaledBalanceOf(user.address);
    expect(wethScaledAfter).to.eq(
      wethScaledBefore,
      'rejected out-of-category borrow must not mint new scaled debt'
    );
    expect(await pool.getUserEMode(user.address)).to.eq(EMODE_ID);
  });

  it('(e) eMode price replacement fires only for in-category assets; out-of-category collateral keeps its standalone oracle', async () => {
    const {
      pool,
      dai,
      aave,
      weth,
      oracle,
      users: [, user],
    } = testEnv;

    // priceSource = WETH so in-category DAI collateral re-prices and we can
    // compare against the out-of-category AAVE collateral that must keep
    // its standalone oracle. AAVE stays OUT of the category.
    await configureCategory(weth.address);

    // Move the eMode priceSource (WETH) to a distinct value so the in-eMode
    // DAI re-price is observable and separable from AAVE's standalone price.
    const daiStandalonePrice = await oracle.getAssetPrice(dai.address);
    const eModePrice = daiStandalonePrice.mul(3);
    await waitForTx(await oracle.setAssetPrice(weth.address, eModePrice));

    // Capture the AAVE standalone price (unchanged by the WETH move).
    const aaveStandalonePrice = await oracle.getAssetPrice(aave.address);

    // User supplies BOTH DAI (in category) and AAVE (NOT in category).
    const daiSupply = await mintApproveSupply(dai, user, '10000');
    const aaveSupply = await mintApproveSupply(aave, user, '50');

    // Both reserves should be collateral for the user.
    await waitForTx(
      await pool.connect(user.signer).setUserUseReserveAsCollateral(dai.address, true)
    );
    await waitForTx(
      await pool.connect(user.signer).setUserUseReserveAsCollateral(aave.address, true)
    );

    await waitForTx(await pool.connect(user.signer).setUserEMode(EMODE_ID));
    expect(await pool.getUserEMode(user.address)).to.eq(EMODE_ID);

    // Expected total = DAI valued at the eMode oracle ($3) + AAVE valued at
    // its standalone oracle (unchanged). Both are 18-dec assets.
    const unit = BigNumber.from(10).pow(18);
    const expectedDaiBase = daiSupply.mul(eModePrice).div(unit);
    const expectedAaveBase = aaveSupply.mul(aaveStandalonePrice).div(unit);
    const expectedTotal = expectedDaiBase.add(expectedAaveBase);

    const account = await pool.getUserAccountData(user.address);
    expect(account.totalCollateralBase).to.eq(
      expectedTotal,
      'mixed-category collateral must price DAI at the eMode oracle AND AAVE at its standalone oracle'
    );
    // Positive, observable separation: the AAVE contribution is strictly
    // present (total exceeds the DAI-only eMode contribution).
    expect(account.totalCollateralBase).to.be.gt(
      expectedDaiBase,
      'out-of-category AAVE collateral must still be counted at its standalone oracle'
    );
  });

  it('(f) eMode borrow accrues variable interest: index moves above RAY and debt grows', async () => {
    const {
      pool,
      dai,
      usdc,
      variableDebtDai,
      users: [depositor, user],
    } = testEnv;

    await configureCategory(ZERO_ADDRESS);

    // Seed DAI liquidity, supply USDC collateral, enter eMode, borrow DAI
    // (an in-category asset) variable, then let time pass and touch the
    // reserve so the variable borrow index moves above RAY.
    await mintApproveSupply(dai, depositor, '1000000');
    await mintApproveSupply(usdc, user, '50000');
    await waitForTx(await pool.connect(user.signer).setUserEMode(EMODE_ID));

    const borrowDai = await convertToCurrencyDecimals(dai.address, '20000');
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(dai.address, borrowDai, RateMode.Variable, '0', user.address)
    );
    const debtBefore = await variableDebtDai.balanceOf(user.address);
    expect(debtBefore).to.be.gt(0, 'borrow must credit variable debt');

    // Accrue a year of interest, then poke the reserve with a 1-wei extra
    // borrow so the index is committed to storage.
    await increaseTime(365 * 24 * 60 * 60);
    const poke = await convertToCurrencyDecimals(dai.address, '1');
    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(dai.address, poke, RateMode.Variable, '0', user.address)
    );

    // Non-vacuous accrual: the variable borrow index is strictly above RAY.
    const liveVarIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
    expect(liveVarIndex).to.be.gt(RAY, 'variable borrow index must move above RAY after accrual');

    // And the borrower's debt strictly grew beyond principal + poke.
    const debtAfter = await variableDebtDai.balanceOf(user.address);
    expect(debtAfter).to.be.gt(debtBefore.add(poke), 'accrued debt must exceed principal + poke');

    // Still inside eMode throughout.
    expect(await pool.getUserEMode(user.address)).to.eq(EMODE_ID);
  });
});
