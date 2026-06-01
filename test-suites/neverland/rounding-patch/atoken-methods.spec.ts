/*
 * Neverland rounding patch: AToken external-method surface (real Pool).
 *
 * The narrowly-scoped specs in this directory cover the matrix-row leaf
 * overrides (mint/burn/_transfer/balanceOf/totalSupply). This file exercises
 * the *rest* of the patched AToken external surface end-to-end against the
 * REAL Pool (makeSuite), so a future refactor or storage-layout regression
 * cannot silently break an inherited entry point:
 *
 *   - permit (EIP-2612): valid signature, expired deadline, invalid signature
 *   - handleRepayment: silent no-op that moves no balances / emits no token logs
 *   - mintToTreasury: floors dust (1-wei-below-threshold is a clean no-op) and
 *     credits the treasury via the real Pool accrual path
 *   - scaled views: scaledBalanceOf, getScaledUserBalanceAndSupply,
 *     getPreviousIndex on the patched leaf
 *   - incentives / controller getters and the onlyPoolAdmin rotation guard
 *
 * VARIABLE RATE ONLY (RateMode.Variable). The Pool fixture already deploys the
 * patched stack; we drive testEnv.pool / testEnv.aDai and never self-deploy.
 *
 * The handleRepayment + dust-floor mintToTreasury behaviors require driving the
 * leaf with crafted (amount, index) inputs that the Pool would never hand it on
 * the happy path. We reproduce them exactly as the upstream atoken-edge.spec
 * does: impersonate the Pool address and call the onlyPool method directly,
 * which still exercises the deployed patched bytecode.
 */

import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import {
  HARDHAT_CHAINID,
  MAX_UINT_AMOUNT,
  ONE_YEAR,
  RAY,
  ZERO_ADDRESS,
} from '../../../helpers/constants';
import {
  buildPermitParams,
  convertToCurrencyDecimals,
  getSignatureFromTypedData,
} from '../../../helpers/contracts-helpers';
import { impersonateAccountsHardhat } from '../../../helpers/misc-utils';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import { topUpNonPayableWithEther } from '../../helpers/utils/funds';
import { getTestWallets } from '../../helpers/utils/wallets';
import '../../helpers/utils/wadraymath';

declare var hre: HardhatRuntimeEnvironment;

const EIP712_REVISION = '1';
const RAY_BN = BigNumber.from(RAY);

// rayDivFloor: the patched mint/treasury scaled-amount direction. Dust below the
// threshold floors to 0 scaled, which the leaf treats as a no-op.
const rayDivFloor = (a: BigNumber, b: BigNumber) => a.mul(RAY_BN).div(b);
const rayMulFloor = (a: BigNumber, b: BigNumber) => a.mul(b).div(RAY_BN);

makeSuite('Neverland rounding patch: AToken external methods', (testEnv: TestEnv) => {
  let snapId: string;
  let testWallets: { secretKey: string; balance: string }[];

  before(async () => {
    testWallets = getTestWallets() as unknown as { secretKey: string; balance: string }[];
  });

  beforeEach(async () => {
    snapId = await evmSnapshot();
    testEnv.aDai = (await hre.ethers.getContractAt(
      'AToken',
      testEnv.aDai.address,
      testEnv.deployer.signer
    )) as TestEnv['aDai'];
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  // Helper: depositor seeds DAI liquidity, borrower posts WETH collateral and
  // takes a variable-rate DAI borrow so the reserve has utilization. Returns the
  // depositor's aDAI scaled balance for downstream assertions.
  const seedSupplyAndBorrow = async () => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '20000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '10');
    const borrowAmount = await convertToCurrencyDecimals(dai.address, '5000');

    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');

    await pool
      .connect(borrower.signer)
      .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address);

    return { depositor, borrower, daiLiquidity, borrowAmount };
  };

  const getPoolSigner = async () => {
    const { deployer, pool } = testEnv;
    await topUpNonPayableWithEther(deployer.signer, [pool.address], utils.parseEther('1'));
    await impersonateAccountsHardhat([pool.address]);
    return hre.ethers.getSigner(pool.address);
  };

  // ---------------------------------------------------------------------------
  // permit (EIP-2612)
  // ---------------------------------------------------------------------------

  it('permit: a valid signature sets the allowance and bumps the nonce', async () => {
    const { aDai, deployer, users } = testEnv;
    const owner = deployer; // deployer == testWallets[0]
    const spender = users[1];

    const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
    const deadline = MAX_UINT_AMOUNT;
    const nonceBefore = (await aDai.nonces(owner.address)).toNumber();
    const permitAmount = utils.parseEther('2').toString();

    const msgParams = buildPermitParams(
      chainId,
      aDai.address,
      EIP712_REVISION,
      await aDai.name(),
      owner.address,
      spender.address,
      nonceBefore,
      deadline,
      permitAmount
    );

    expect((await aDai.allowance(owner.address, spender.address)).toString()).to.eq('0');

    const { v, r, s } = getSignatureFromTypedData(testWallets[0].secretKey, msgParams);

    await waitForTx(
      await aDai
        .connect(spender.signer)
        .permit(owner.address, spender.address, permitAmount, deadline, v, r, s)
    );

    // Positive observable effect: allowance written exactly, nonce advanced by 1.
    expect((await aDai.allowance(owner.address, spender.address)).toString()).to.eq(permitAmount);
    expect((await aDai.nonces(owner.address)).toNumber()).to.eq(nonceBefore + 1);
  });

  it('permit: a zero (past) deadline reverts INVALID_EXPIRATION and leaves allowance + nonce untouched', async () => {
    const { aDai, deployer, users } = testEnv;
    const owner = deployer;
    const spender = users[1];

    const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
    const expiration = '0';
    const nonceBefore = (await aDai.nonces(owner.address)).toNumber();
    const permitAmount = utils.parseEther('2').toString();

    const msgParams = buildPermitParams(
      chainId,
      aDai.address,
      EIP712_REVISION,
      await aDai.name(),
      owner.address,
      spender.address,
      nonceBefore,
      expiration,
      permitAmount
    );

    const { v, r, s } = getSignatureFromTypedData(testWallets[0].secretKey, msgParams);

    await expect(
      aDai
        .connect(spender.signer)
        .permit(owner.address, spender.address, permitAmount, expiration, v, r, s)
    ).to.be.revertedWith(ProtocolErrors.INVALID_EXPIRATION);

    // Positive observable effect: the failed permit changed nothing.
    expect((await aDai.allowance(owner.address, spender.address)).toString()).to.eq('0');
    expect((await aDai.nonces(owner.address)).toNumber()).to.eq(nonceBefore);
  });

  it('permit: a signature with the wrong nonce reverts INVALID_SIGNATURE and leaves state untouched', async () => {
    const { aDai, deployer, users } = testEnv;
    const owner = deployer;
    const spender = users[1];

    const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
    const deadline = MAX_UINT_AMOUNT;
    const nonceBefore = (await aDai.nonces(owner.address)).toNumber();
    const wrongNonce = nonceBefore + 1000;
    const permitAmount = utils.parseEther('2').toString();

    // Sign over a nonce the contract will never match, so ecrecover yields an
    // address that is not `owner`.
    const msgParams = buildPermitParams(
      chainId,
      aDai.address,
      EIP712_REVISION,
      await aDai.name(),
      owner.address,
      spender.address,
      wrongNonce,
      deadline,
      permitAmount
    );

    const { v, r, s } = getSignatureFromTypedData(testWallets[0].secretKey, msgParams);

    await expect(
      aDai
        .connect(spender.signer)
        .permit(owner.address, spender.address, permitAmount, deadline, v, r, s)
    ).to.be.revertedWith(ProtocolErrors.INVALID_SIGNATURE);

    expect((await aDai.allowance(owner.address, spender.address)).toString()).to.eq('0');
    expect((await aDai.nonces(owner.address)).toNumber()).to.eq(nonceBefore);
  });

  it('permit: the DOMAIN_SEPARATOR matches the off-chain EIP-712 reconstruction', async () => {
    const { aDai } = testEnv;
    const chainId = hre.network.config.chainId || HARDHAT_CHAINID;

    const expected = utils._TypedDataEncoder.hashDomain({
      name: await aDai.name(),
      version: EIP712_REVISION,
      chainId,
      verifyingContract: aDai.address,
    });

    expect(await aDai.DOMAIN_SEPARATOR()).to.eq(expected);
  });

  // ---------------------------------------------------------------------------
  // handleRepayment: silent no-op
  // ---------------------------------------------------------------------------

  it('handleRepayment: is a balance-neutral no-op that emits no token events', async () => {
    const { aDai } = testEnv;
    const { depositor, borrower } = await seedSupplyAndBorrow();

    const poolSigner = await getPoolSigner();

    const depositorScaledBefore = await aDai.scaledBalanceOf(depositor.address);
    const borrowerScaledBefore = await aDai.scaledBalanceOf(borrower.address);
    const scaledTotalBefore = await aDai.scaledTotalSupply();

    // Sanity: there is something to move, so a silent revert can't masquerade
    // as a no-op pass.
    expect(depositorScaledBefore).to.be.gt(0);

    const tx = await aDai
      .connect(poolSigner)
      .handleRepayment(borrower.address, borrower.address, utils.parseEther('1234'));
    const receipt = await tx.wait();

    // No Transfer / Mint / Burn / BalanceTransfer emitted from the AToken.
    const tokenTopics = receipt.logs
      .filter((l) => l.address.toLowerCase() === aDai.address.toLowerCase())
      .map((l) => l.topics[0]);
    for (const evName of ['Transfer', 'Mint', 'Burn', 'BalanceTransfer']) {
      expect(tokenTopics).to.not.include(aDai.interface.getEventTopic(evName));
    }

    // Positive observable effect: balances and scaled supply are byte-identical.
    expect(await aDai.scaledBalanceOf(depositor.address)).to.eq(depositorScaledBefore);
    expect(await aDai.scaledBalanceOf(borrower.address)).to.eq(borrowerScaledBefore);
    expect(await aDai.scaledTotalSupply()).to.eq(scaledTotalBefore);
  });

  it('handleRepayment: reverts for any caller other than the Pool', async () => {
    const {
      aDai,
      users: [, , mallory],
    } = testEnv;

    await expect(aDai.connect(mallory.signer).handleRepayment(mallory.address, mallory.address, 1))
      .to.be.reverted;
  });

  // ---------------------------------------------------------------------------
  // mintToTreasury: dust floor + real-Pool credit
  // ---------------------------------------------------------------------------

  it('mintToTreasury: dust 1-wei below the scaling threshold is a clean no-op (floor -> 0 scaled)', async () => {
    const { aDai } = testEnv;
    await seedSupplyAndBorrow();

    const poolSigner = await getPoolSigner();
    const treasury = await aDai.RESERVE_TREASURY_ADDRESS();

    // amount=1, idx=2*RAY -> rayDivFloor == 0. The leaf catches the floored-to-
    // zero scaled amount and returns without crediting or moving supply. This is
    // exactly 1 wei below the 2-wei threshold that would mint 1 scaled unit.
    const dustAmount = BigNumber.from(1);
    const idx = RAY_BN.mul(2);
    expect(rayDivFloor(dustAmount, idx)).to.eq(0);
    // 2 wei at the same index would round to a non-zero scaled credit; this
    // proves we are exactly one wei under the floor threshold.
    expect(rayDivFloor(BigNumber.from(2), idx)).to.eq(1);

    const treasuryScaledBefore = await aDai.scaledBalanceOf(treasury);
    const scaledTotalBefore = await aDai.scaledTotalSupply();

    await waitForTx(await aDai.connect(poolSigner).mintToTreasury(dustAmount, idx));

    // Positive observable effect: nothing was credited.
    expect(await aDai.scaledBalanceOf(treasury)).to.eq(treasuryScaledBefore);
    expect(await aDai.scaledTotalSupply()).to.eq(scaledTotalBefore);
  });

  it('mintToTreasury: a non-zero scaled credit increases the treasury scaled balance and total supply', async () => {
    const { aDai } = testEnv;
    await seedSupplyAndBorrow();

    const poolSigner = await getPoolSigner();
    const treasury = await aDai.RESERVE_TREASURY_ADDRESS();

    const amount = await convertToCurrencyDecimals(aDai.address, '100');
    const idx = BigNumber.from('1234567890123456789012345678');
    const expectedScaledDelta = rayDivFloor(amount, idx);
    expect(expectedScaledDelta).to.be.gt(0);

    const treasuryScaledBefore = await aDai.scaledBalanceOf(treasury);
    const scaledTotalBefore = await aDai.scaledTotalSupply();

    await waitForTx(await aDai.connect(poolSigner).mintToTreasury(amount, idx));

    expect((await aDai.scaledBalanceOf(treasury)).sub(treasuryScaledBefore)).to.eq(
      expectedScaledDelta
    );
    expect((await aDai.scaledTotalSupply()).sub(scaledTotalBefore)).to.eq(expectedScaledDelta);
  });

  it('mintToTreasury: the real Pool path floors accrued reserve-factor dust into the treasury', async () => {
    const { pool, dai, aDai, helpersContract } = testEnv;
    const { depositor } = await seedSupplyAndBorrow();

    // Accrue interest: utilization is live, so a full year + a state-touching tx
    // moves both indexes above RAY.
    await increaseTime(parseInt(ONE_YEAR));

    // Re-supply to force the reserve state (and accruedToTreasury) to update.
    const bump = await convertToCurrencyDecimals(dai.address, '1');
    await dai.connect(depositor.signer)['mint(uint256)'](bump);
    await pool.connect(depositor.signer).supply(dai.address, bump, depositor.address, '0');

    const reserveData = await pool.getReserveData(dai.address);
    // Index must have actually moved before relying on accrual residue.
    expect(reserveData.liquidityIndex).to.be.gt(RAY_BN);
    expect(reserveData.variableBorrowIndex).to.be.gt(RAY_BN);

    const { reserveFactor } = await helpersContract.getReserveConfigurationData(dai.address);
    expect(reserveFactor).to.be.gt(0);

    const accruedToTreasury = reserveData.accruedToTreasury;
    expect(accruedToTreasury).to.be.gt(0);

    const treasury = await aDai.RESERVE_TREASURY_ADDRESS();
    const treasuryBalanceBefore = await aDai.balanceOf(treasury);

    await waitForTx(await pool.mintToTreasury([dai.address]));

    const normalizedIncome = await pool.getReserveNormalizedIncome(dai.address);
    const treasuryBalanceAfter = await aDai.balanceOf(treasury);

    // Positive observable effect: the treasury balance grew by the floor-visible
    // amount emitted by PoolLogic after the ceil amount-ABI promotion.
    expect(treasuryBalanceAfter).to.be.gt(treasuryBalanceBefore);
    const expectedDelta = rayMulFloor(accruedToTreasury, normalizedIncome);
    expect(treasuryBalanceAfter.sub(treasuryBalanceBefore)).to.eq(expectedDelta);

    // The accrued counter is consumed by the mint.
    expect((await pool.getReserveData(dai.address)).accruedToTreasury).to.eq(0);
  });

  it('mintToTreasury: reverts for any caller other than the Pool', async () => {
    const {
      aDai,
      users: [, , mallory],
    } = testEnv;

    await expect(aDai.connect(mallory.signer).mintToTreasury(1, RAY_BN)).to.be.reverted;
  });

  // ---------------------------------------------------------------------------
  // scaled views on the patched leaf
  // ---------------------------------------------------------------------------

  it('scaledBalanceOf / getScaledUserBalanceAndSupply: zero before supply, then the raw scaled balance', async () => {
    const { pool, dai, aDai, users } = testEnv;
    const supplier = users[3];

    // Zero state up front.
    expect(await aDai.scaledBalanceOf(supplier.address)).to.eq(0);
    const before = await aDai.getScaledUserBalanceAndSupply(supplier.address);
    expect(before[0]).to.eq(0);
    expect(before[1]).to.eq(0);

    const amount = await convertToCurrencyDecimals(dai.address, '1000');
    await dai.connect(supplier.signer)['mint(uint256)'](amount);
    await dai.connect(supplier.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(supplier.signer).supply(dai.address, amount, supplier.address, '0');

    // At a fresh reserve liquidityIndex == RAY, so scaled == amount.
    const scaled = await aDai.scaledBalanceOf(supplier.address);
    expect(scaled).to.be.gt(0);
    expect(scaled).to.eq(amount);

    const after = await aDai.getScaledUserBalanceAndSupply(supplier.address);
    // Positive observable effect: tuple[0] == scaledBalanceOf and tuple[1] is the
    // scaled total supply, both reflecting the new supply.
    expect(after[0]).to.eq(scaled);
    expect(after[1]).to.eq(await aDai.scaledTotalSupply());
    expect(after[1]).to.be.gte(scaled);
  });

  it('getPreviousIndex: records the per-user index snapshot from the last balance-changing action', async () => {
    const { pool, dai, aDai, users } = testEnv;
    const supplier = users[3];

    const amount = await convertToCurrencyDecimals(dai.address, '1000');
    await dai.connect(supplier.signer)['mint(uint256)'](amount);
    await dai.connect(supplier.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(supplier.signer).supply(dai.address, amount, supplier.address, '0');

    // Fresh reserve: the stored previous index is exactly RAY.
    expect(await aDai.getPreviousIndex(supplier.address)).to.eq(RAY_BN);

    // Drive utilization + time so the income index climbs above RAY.
    await seedSupplyAndBorrow();
    await increaseTime(parseInt(ONE_YEAR));

    // A second supply re-snapshots the user's index to the live (now > RAY) one.
    const bump = await convertToCurrencyDecimals(dai.address, '500');
    await dai.connect(supplier.signer)['mint(uint256)'](bump);
    await pool.connect(supplier.signer).supply(dai.address, bump, supplier.address, '0');

    const liveIndex = await pool.getReserveNormalizedIncome(dai.address);
    // The income index must have actually moved before relying on the snapshot.
    expect(liveIndex).to.be.gt(RAY_BN);

    // Positive observable effect: the stored previous index advanced past RAY and
    // matches the live normalized income captured at the supply.
    const previousIndex = await aDai.getPreviousIndex(supplier.address);
    expect(previousIndex).to.be.gt(RAY_BN);
    expect(previousIndex).to.eq(liveIndex);
  });

  it('scaledBalanceOf is NOT repriced by the live index (floor read stays below the unscaled balance)', async () => {
    const { pool, dai, aDai, users } = testEnv;
    const supplier = users[3];

    const amount = await convertToCurrencyDecimals(dai.address, '1000');
    await dai.connect(supplier.signer)['mint(uint256)'](amount);
    await dai.connect(supplier.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(supplier.signer).supply(dai.address, amount, supplier.address, '0');

    const scaledAfterSupply = await aDai.scaledBalanceOf(supplier.address);

    // Accrue interest so the unscaled balance grows while the scaled balance is
    // frozen.
    await seedSupplyAndBorrow();
    await increaseTime(parseInt(ONE_YEAR));
    // Touch state so getReserveNormalizedIncome reflects the accrual.
    const bump = await convertToCurrencyDecimals(dai.address, '1');
    await dai.connect(supplier.signer)['mint(uint256)'](bump);
    await pool.connect(supplier.signer).supply(dai.address, bump, supplier.address, '0');

    const liveIndex = await pool.getReserveNormalizedIncome(dai.address);
    expect(liveIndex).to.be.gt(RAY_BN);

    // Positive observable effect: the unscaled balanceOf now strictly exceeds the
    // scaled balance from the first supply (interest accrued), while scaled views
    // remain raw (no live-index multiply applied).
    const unscaled = await aDai.balanceOf(supplier.address);
    expect(unscaled).to.be.gt(scaledAfterSupply);
    expect(await aDai.scaledBalanceOf(supplier.address)).to.be.lt(unscaled);
  });

  // ---------------------------------------------------------------------------
  // incentives controller wiring
  // ---------------------------------------------------------------------------

  it('getIncentivesController: returns the non-zero controller wired at listing', async () => {
    const { aDai } = testEnv;
    // The lending fixture lists reserves with a real incentives controller.
    expect(await aDai.getIncentivesController()).to.not.eq(ZERO_ADDRESS);
  });

  it('setIncentivesController: rotation is gated by onlyPoolAdmin and round-trips when authorized', async () => {
    const {
      deployer,
      poolAdmin,
      aDai,
      aclManager,
      users: [, , mallory],
    } = testEnv;

    const original = await aDai.getIncentivesController();
    expect(original).to.not.eq(ZERO_ADDRESS);

    // A non-admin cannot rotate the controller.
    await expect(
      aDai.connect(mallory.signer).setIncentivesController(ZERO_ADDRESS)
    ).to.be.revertedWith(ProtocolErrors.CALLER_NOT_POOL_ADMIN);
    // Positive observable effect: a failed rotation left the controller intact.
    expect(await aDai.getIncentivesController()).to.eq(original);

    // The pool admin can rotate it to a new value and back.
    await waitForTx(await aclManager.connect(deployer.signer).addPoolAdmin(poolAdmin.address));
    await waitForTx(await aDai.connect(poolAdmin.signer).setIncentivesController(mallory.address));
    expect(await aDai.getIncentivesController()).to.eq(mallory.address);

    await waitForTx(await aDai.connect(poolAdmin.signer).setIncentivesController(original));
    expect(await aDai.getIncentivesController()).to.eq(original);
  });

  it('immutable getters: POOL / UNDERLYING_ASSET_ADDRESS / RESERVE_TREASURY_ADDRESS match the listing', async () => {
    const { pool, dai, aDai } = testEnv;

    expect(await aDai.POOL()).to.eq(pool.address);
    expect(await aDai.UNDERLYING_ASSET_ADDRESS()).to.eq(dai.address);
    expect(await aDai.RESERVE_TREASURY_ADDRESS()).to.not.eq(ZERO_ADDRESS);
    // decimals mirror the underlying.
    expect(await aDai.decimals()).to.eq(await dai.decimals());
  });
});
