/*
 * VariableDebtToken external-method surface, exercised end-to-end through the
 * REAL patched Pool (makeSuite), variable-rate only.
 *
 * Mirrors the POOL-repo `vtoken-methods-comprehensive.spec.ts` scenarios, but
 * re-expressed on the lending `makeSuite` harness: there is no
 * `MockPoolForVTokenTests` here, so every mint/burn is driven by an actual
 * `pool.borrow`/`pool.repay`, and the live index is moved by real utilization +
 * time rather than `setIndex`. The patched leaf rounds VToken mint UP (ceil),
 * partial burn DOWN (floor) and balance UP (ceil); a full repay must clamp the
 * scaled balance to exactly zero with no dust.
 *
 * Behaviors covered:
 *   - delegationWithSig EIP-712: valid (allowance set, nonce++), tampered value
 *     (INVALID_SIGNATURE), expired deadline (INVALID_EXPIRATION), zero delegator
 *     (ZERO_ADDRESS_NOT_VALID), replay (INVALID_SIGNATURE), plus approveDelegation
 *     overwrite + on-behalf borrow consuming allowance.
 *   - non-transferable ERC20 guards: transfer / transferFrom / approve / allowance
 *     / increaseAllowance / decreaseAllowance all revert OPERATION_NOT_SUPPORTED.
 *   - scaled views: scaledBalanceOf / scaledTotalSupply / getScaledUserBalanceAndSupply
 *     / getPreviousIndex through a real borrow, index-invariance of scaledBalanceOf.
 *   - mint/burn edge cases: ceil mint (balanceOf >= borrowed), floor partial burn
 *     (scaled drops by floor, residual debt remains), full-repay clamp to zero.
 */

import { evmRevert, evmSnapshot, increaseTime, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { HARDHAT_CHAINID, MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../../../helpers/constants';
import {
  buildDelegationWithSigParams,
  convertToCurrencyDecimals,
  getSignatureFromTypedData,
} from '../../../helpers/contracts-helpers';
import { timeLatest } from '../../../helpers/misc-utils';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { getTestWallets } from '../../helpers/utils/wallets';

declare var hre: HardhatRuntimeEnvironment;

const RAY = BigNumber.from(10).pow(27);
const EIP712_REVISION = '1';

// rayMulCeil mirrors the patched getVTokenBalance direction (debt rounds UP).
const rayMulCeil = (a: BigNumber, b: BigNumber): BigNumber => {
  const product = a.mul(b);
  const q = product.div(RAY);
  return product.mod(RAY).isZero() ? q : q.add(1);
};

makeSuite('Neverland rounding patch: VariableDebtToken methods (real Pool)', (testEnv: TestEnv) => {
  let snapId: string;
  let testWallets: ReturnType<typeof getTestWallets>;

  beforeEach(async () => {
    testWallets = getTestWallets();
    snapId = await evmSnapshot();
    testEnv.variableDebtDai = (await hre.ethers.getContractAt(
      'VariableDebtToken',
      testEnv.variableDebtDai.address,
      testEnv.deployer.signer
    )) as TestEnv['variableDebtDai'];
  });
  afterEach(async () => {
    await evmRevert(snapId);
  });

  // Seed DAI liquidity from `depositor` and WETH collateral for `borrower`,
  // then borrow `borrowAmount` DAI variable. Returns nothing; callers read state.
  const seedAndBorrow = async (
    pool: TestEnv['pool'],
    dai: TestEnv['dai'],
    weth: TestEnv['weth'],
    depositor: TestEnv['users'][number],
    borrower: TestEnv['users'][number],
    borrowAmount: BigNumber
  ) => {
    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '100');

    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');

    await pool
      .connect(borrower.signer)
      .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address);
  };

  // --------------------------------------------------------------------- //
  // delegationWithSig (EIP-712)                                            //
  // --------------------------------------------------------------------- //
  describe('delegationWithSig (EIP-712)', () => {
    it('DOMAIN_SEPARATOR matches the recomputed EIP-712 domain digest', async () => {
      const { variableDebtDai } = testEnv;
      const separator = await variableDebtDai.DOMAIN_SEPARATOR();
      const domain = {
        name: await variableDebtDai.name(),
        version: EIP712_REVISION,
        chainId: hre.network.config.chainId,
        verifyingContract: variableDebtDai.address,
      };
      const expected = utils._TypedDataEncoder.hashDomain(domain);
      expect(separator).to.equal(expected, 'Invalid variable domain separator');
    });

    it('a valid signature sets the borrowAllowance and increments the delegator nonce', async () => {
      const {
        variableDebtDai,
        deployer: relayer,
        users: [delegator, delegatee],
      } = testEnv;

      const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
      const expiration = MAX_UINT_AMOUNT;
      const nonceBefore = (await variableDebtDai.nonces(delegator.address)).toNumber();
      expect(nonceBefore).to.equal(0);
      const permitAmount = await convertToCurrencyDecimals(variableDebtDai.address, '500');

      const msgParams = buildDelegationWithSigParams(
        chainId,
        variableDebtDai.address,
        EIP712_REVISION,
        await variableDebtDai.name(),
        delegatee.address,
        nonceBefore,
        expiration,
        permitAmount.toString()
      );

      // delegator is users[0] -> testWallets[1] (deployer is testWallets[0]).
      const delegatorPrivateKey = testWallets[1].secretKey;
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(0);

      const { v, r, s } = getSignatureFromTypedData(delegatorPrivateKey, msgParams);

      await waitForTx(
        await variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(
            delegator.address,
            delegatee.address,
            permitAmount,
            expiration,
            v,
            r,
            s
          )
      );

      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(
        permitAmount
      );
      expect(await variableDebtDai.nonces(delegator.address)).to.eq(1);
    });

    it('a valid signature lets the delegatee draw the delegated debt via the Pool', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        deployer: relayer,
        users: [depositor, delegatee, delegator],
      } = testEnv;

      // Liquidity + delegator collateral so the on-behalf borrow can succeed.
      const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
      const wethCollateral = await convertToCurrencyDecimals(weth.address, '100');
      await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
      await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(depositor.signer)
        .supply(dai.address, daiLiquidity, depositor.address, '0');
      await weth
        .connect(delegator.signer)
        ['mint(address,uint256)'](delegator.address, wethCollateral);
      await weth.connect(delegator.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(delegator.signer)
        .supply(weth.address, wethCollateral, delegator.address, '0');

      const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
      const expiration = MAX_UINT_AMOUNT;
      const nonce = (await variableDebtDai.nonces(delegator.address)).toNumber();
      const permitAmount = await convertToCurrencyDecimals(variableDebtDai.address, '300');

      const msgParams = buildDelegationWithSigParams(
        chainId,
        variableDebtDai.address,
        EIP712_REVISION,
        await variableDebtDai.name(),
        delegatee.address,
        nonce,
        expiration,
        permitAmount.toString()
      );
      // delegator is users[2] -> testWallets[3].
      const delegatorPrivateKey = testWallets[3].secretKey;
      const { v, r, s } = getSignatureFromTypedData(delegatorPrivateKey, msgParams);

      await waitForTx(
        await variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(
            delegator.address,
            delegatee.address,
            permitAmount,
            expiration,
            v,
            r,
            s
          )
      );
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(
        permitAmount
      );

      // Delegatee borrows the full delegated amount on behalf of the delegator.
      await pool
        .connect(delegatee.signer)
        .borrow(dai.address, permitAmount, RateMode.Variable, '0', delegator.address);

      // Allowance fully consumed and the delegator now carries the debt.
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(0);
      expect(await variableDebtDai.balanceOf(delegator.address)).to.be.gte(permitAmount);
      expect(await variableDebtDai.scaledBalanceOf(delegator.address)).to.be.gt(0);
      expect(await variableDebtDai.balanceOf(delegatee.address)).to.eq(0);
    });

    it('reverts INVALID_SIGNATURE on a tampered value', async () => {
      const {
        variableDebtDai,
        deployer: relayer,
        users: [delegator, delegatee],
      } = testEnv;

      const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
      const expiration = MAX_UINT_AMOUNT;
      const nonce = (await variableDebtDai.nonces(delegator.address)).toNumber();
      const signedAmount = await convertToCurrencyDecimals(variableDebtDai.address, '100');
      const submittedAmount = await convertToCurrencyDecimals(variableDebtDai.address, '200');

      const msgParams = buildDelegationWithSigParams(
        chainId,
        variableDebtDai.address,
        EIP712_REVISION,
        await variableDebtDai.name(),
        delegatee.address,
        nonce,
        expiration,
        signedAmount.toString()
      );
      const delegatorPrivateKey = testWallets[1].secretKey;
      const { v, r, s } = getSignatureFromTypedData(delegatorPrivateKey, msgParams);

      await expect(
        variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(
            delegator.address,
            delegatee.address,
            submittedAmount,
            expiration,
            v,
            r,
            s
          )
      ).to.be.revertedWith(ProtocolErrors.INVALID_SIGNATURE);

      // No state mutation on a rejected signature.
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(0);
      expect(await variableDebtDai.nonces(delegator.address)).to.eq(0);
    });

    it('reverts INVALID_EXPIRATION on an expired deadline', async () => {
      const {
        variableDebtDai,
        deployer: relayer,
        users: [delegator, delegatee],
      } = testEnv;

      const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
      const expiration = (await timeLatest()).sub(500).toString();
      const nonce = (await variableDebtDai.nonces(delegator.address)).toNumber();
      const permitAmount = await convertToCurrencyDecimals(variableDebtDai.address, '100');

      const msgParams = buildDelegationWithSigParams(
        chainId,
        variableDebtDai.address,
        EIP712_REVISION,
        await variableDebtDai.name(),
        delegatee.address,
        nonce,
        expiration,
        permitAmount.toString()
      );
      const delegatorPrivateKey = testWallets[1].secretKey;
      const { v, r, s } = getSignatureFromTypedData(delegatorPrivateKey, msgParams);

      await expect(
        variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(
            delegator.address,
            delegatee.address,
            permitAmount,
            expiration,
            v,
            r,
            s
          )
      ).to.be.revertedWith(ProtocolErrors.INVALID_EXPIRATION);

      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(0);
      expect(await variableDebtDai.nonces(delegator.address)).to.eq(0);
    });

    it('reverts ZERO_ADDRESS_NOT_VALID when the delegator is the zero address', async () => {
      const {
        variableDebtDai,
        deployer: relayer,
        users: [delegator, delegatee],
      } = testEnv;

      const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
      const expiration = MAX_UINT_AMOUNT;
      const nonce = (await variableDebtDai.nonces(delegator.address)).toNumber();
      const permitAmount = await convertToCurrencyDecimals(variableDebtDai.address, '100');

      const msgParams = buildDelegationWithSigParams(
        chainId,
        variableDebtDai.address,
        EIP712_REVISION,
        await variableDebtDai.name(),
        delegatee.address,
        nonce,
        expiration,
        permitAmount.toString()
      );
      const delegatorPrivateKey = testWallets[1].secretKey;
      const { v, r, s } = getSignatureFromTypedData(delegatorPrivateKey, msgParams);

      await expect(
        variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(ZERO_ADDRESS, delegatee.address, permitAmount, expiration, v, r, s)
      ).to.be.revertedWith(ProtocolErrors.ZERO_ADDRESS_NOT_VALID);

      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(0);
    });

    it('rejects a replayed signature (nonce consumed on first use)', async () => {
      const {
        variableDebtDai,
        deployer: relayer,
        users: [delegator, delegatee],
      } = testEnv;

      const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
      const expiration = MAX_UINT_AMOUNT;
      const nonce = (await variableDebtDai.nonces(delegator.address)).toNumber();
      const permitAmount = await convertToCurrencyDecimals(variableDebtDai.address, '42');

      const msgParams = buildDelegationWithSigParams(
        chainId,
        variableDebtDai.address,
        EIP712_REVISION,
        await variableDebtDai.name(),
        delegatee.address,
        nonce,
        expiration,
        permitAmount.toString()
      );
      const delegatorPrivateKey = testWallets[1].secretKey;
      const { v, r, s } = getSignatureFromTypedData(delegatorPrivateKey, msgParams);

      await waitForTx(
        await variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(
            delegator.address,
            delegatee.address,
            permitAmount,
            expiration,
            v,
            r,
            s
          )
      );
      expect(await variableDebtDai.nonces(delegator.address)).to.eq(1);
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(
        permitAmount
      );

      // The same signature is now stale: nonce moved to 1.
      await expect(
        variableDebtDai
          .connect(relayer.signer)
          .delegationWithSig(
            delegator.address,
            delegatee.address,
            permitAmount,
            expiration,
            v,
            r,
            s
          )
      ).to.be.revertedWith(ProtocolErrors.INVALID_SIGNATURE);

      // Replay rejected, no further nonce movement.
      expect(await variableDebtDai.nonces(delegator.address)).to.eq(1);
    });
  });

  // --------------------------------------------------------------------- //
  // approveDelegation / borrowAllowance                                    //
  // --------------------------------------------------------------------- //
  describe('approveDelegation / borrowAllowance', () => {
    it('stores and overwrites (does not add) the approved delegation amount', async () => {
      const {
        variableDebtDai,
        users: [delegator, delegatee],
      } = testEnv;

      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(0);

      await waitForTx(
        await variableDebtDai.connect(delegator.signer).approveDelegation(delegatee.address, 100)
      );
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(
        100
      );

      // Per Aave ICreditDelegationToken, the second call REPLACES the prior value.
      await waitForTx(
        await variableDebtDai.connect(delegator.signer).approveDelegation(delegatee.address, 50)
      );
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(50);
    });

    it('emits BorrowAllowanceDelegated on approveDelegation', async () => {
      const {
        dai,
        variableDebtDai,
        users: [delegator, delegatee],
      } = testEnv;

      await expect(
        variableDebtDai.connect(delegator.signer).approveDelegation(delegatee.address, 999)
      )
        .to.emit(variableDebtDai, 'BorrowAllowanceDelegated')
        .withArgs(delegator.address, delegatee.address, dai.address, 999);
    });

    it('an on-behalf borrow consumes the delegated allowance down to the residual', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        users: [depositor, delegatee, delegator],
      } = testEnv;

      const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
      const wethCollateral = await convertToCurrencyDecimals(weth.address, '100');
      await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
      await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(depositor.signer)
        .supply(dai.address, daiLiquidity, depositor.address, '0');
      await weth
        .connect(delegator.signer)
        ['mint(address,uint256)'](delegator.address, wethCollateral);
      await weth.connect(delegator.signer).approve(pool.address, MAX_UINT_AMOUNT);
      await pool
        .connect(delegator.signer)
        .supply(weth.address, wethCollateral, delegator.address, '0');

      const allowance = await convertToCurrencyDecimals(dai.address, '500');
      const borrowAmount = await convertToCurrencyDecimals(dai.address, '300');
      await waitForTx(
        await variableDebtDai
          .connect(delegator.signer)
          .approveDelegation(delegatee.address, allowance)
      );

      await pool
        .connect(delegatee.signer)
        .borrow(dai.address, borrowAmount, RateMode.Variable, '0', delegator.address);

      // Residual allowance == allowance - borrowAmount (same-block, no accrual);
      // the delegator carries the new debt.
      expect(await variableDebtDai.borrowAllowance(delegator.address, delegatee.address)).to.eq(
        allowance.sub(borrowAmount)
      );
      expect(await variableDebtDai.balanceOf(delegator.address)).to.be.gte(borrowAmount);
    });
  });

  // --------------------------------------------------------------------- //
  // Non-transferable ERC20 surface                                         //
  // --------------------------------------------------------------------- //
  describe('non-transferable ERC20 guards (OPERATION_NOT_SUPPORTED)', () => {
    it('transfer reverts OPERATION_NOT_SUPPORTED', async () => {
      const {
        variableDebtDai,
        users: [a, b],
      } = testEnv;
      await expect(variableDebtDai.connect(a.signer).transfer(b.address, 500)).to.be.revertedWith(
        ProtocolErrors.OPERATION_NOT_SUPPORTED
      );
    });

    it('transferFrom reverts OPERATION_NOT_SUPPORTED', async () => {
      const {
        variableDebtDai,
        users: [a, b],
      } = testEnv;
      await expect(
        variableDebtDai.connect(a.signer).transferFrom(a.address, b.address, 500)
      ).to.be.revertedWith(ProtocolErrors.OPERATION_NOT_SUPPORTED);
    });

    it('approve reverts OPERATION_NOT_SUPPORTED', async () => {
      const {
        variableDebtDai,
        users: [a, b],
      } = testEnv;
      await expect(variableDebtDai.connect(a.signer).approve(b.address, 500)).to.be.revertedWith(
        ProtocolErrors.OPERATION_NOT_SUPPORTED
      );
    });

    it('allowance reverts OPERATION_NOT_SUPPORTED', async () => {
      const {
        variableDebtDai,
        users: [a, b],
      } = testEnv;
      await expect(variableDebtDai.allowance(a.address, b.address)).to.be.revertedWith(
        ProtocolErrors.OPERATION_NOT_SUPPORTED
      );
    });

    it('increaseAllowance reverts OPERATION_NOT_SUPPORTED', async () => {
      const {
        variableDebtDai,
        users: [a, b],
      } = testEnv;
      await expect(
        variableDebtDai.connect(a.signer).increaseAllowance(b.address, 500)
      ).to.be.revertedWith(ProtocolErrors.OPERATION_NOT_SUPPORTED);
    });

    it('decreaseAllowance reverts OPERATION_NOT_SUPPORTED', async () => {
      const {
        variableDebtDai,
        users: [a, b],
      } = testEnv;
      await expect(
        variableDebtDai.connect(a.signer).decreaseAllowance(b.address, 0)
      ).to.be.revertedWith(ProtocolErrors.OPERATION_NOT_SUPPORTED);
    });
  });

  // --------------------------------------------------------------------- //
  // Scaled views through a real borrow                                     //
  // --------------------------------------------------------------------- //
  describe('scaled views (scaledBalanceOf / scaledTotalSupply / getScaledUserBalanceAndSupply / getPreviousIndex)', () => {
    it('a fresh user has zero scaled balance, supply, and previous index', async () => {
      const {
        variableDebtDai,
        users: [user],
      } = testEnv;
      expect(await variableDebtDai.scaledBalanceOf(user.address)).to.eq(0);
      expect(await variableDebtDai.scaledTotalSupply()).to.eq(0);
      expect(await variableDebtDai.getPreviousIndex(user.address)).to.eq(0);
      const [scaled, supply] = await variableDebtDai.getScaledUserBalanceAndSupply(user.address);
      expect(scaled).to.eq(0);
      expect(supply).to.eq(0);
    });

    it('a borrow populates scaled balance == scaled supply and records the borrow index', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        users: [depositor, borrower],
      } = testEnv;

      const borrowAmount = await convertToCurrencyDecimals(dai.address, '500');
      await seedAndBorrow(pool, dai, weth, depositor, borrower, borrowAmount);

      const scaled = await variableDebtDai.scaledBalanceOf(borrower.address);
      expect(scaled).to.be.gt(0);
      // Borrower is the only debtor, so scaled balance == scaled total supply.
      expect(await variableDebtDai.scaledTotalSupply()).to.eq(scaled);

      const [scaledUser, scaledSupply] = await variableDebtDai.getScaledUserBalanceAndSupply(
        borrower.address
      );
      expect(scaledUser).to.eq(scaled);
      expect(scaledSupply).to.eq(scaled);

      // getPreviousIndex captured the variable borrow index at borrow time (>= RAY).
      const prevIndex = await variableDebtDai.getPreviousIndex(borrower.address);
      expect(prevIndex).to.be.gte(RAY);

      // balanceOf == rayMulCeil(scaled, liveVariableDebtIndex): ceil rounds in protocol's favor.
      const liveIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
      expect(await variableDebtDai.balanceOf(borrower.address)).to.eq(
        rayMulCeil(scaled, liveIndex)
      );
    });

    it('scaledBalanceOf stays flat while interest accrues but balanceOf grows', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        users: [depositor, borrower],
      } = testEnv;

      const borrowAmount = await convertToCurrencyDecimals(dai.address, '5000');
      await seedAndBorrow(pool, dai, weth, depositor, borrower, borrowAmount);

      const scaledBefore = await variableDebtDai.scaledBalanceOf(borrower.address);
      const balanceBefore = await variableDebtDai.balanceOf(borrower.address);
      expect(scaledBefore).to.be.gt(0);

      // Let a year of variable interest accrue, then touch state so the index moves.
      await increaseTime(365 * 24 * 60 * 60);
      // A tiny extra borrow forces a state-touching reserve update.
      await pool
        .connect(borrower.signer)
        .borrow(
          dai.address,
          await convertToCurrencyDecimals(dai.address, '1'),
          RateMode.Variable,
          '0',
          borrower.address
        );

      // Index actually moved above RAY (non-vacuous accrual guard).
      const liveIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
      expect(liveIndex).to.be.gt(RAY);

      // scaledBalanceOf only changed by the +1 DAI borrow's scaled delta, NOT by accrual.
      const scaledAfter = await variableDebtDai.scaledBalanceOf(borrower.address);
      const balanceAfter = await variableDebtDai.balanceOf(borrower.address);
      // Debt grew strictly more than the 1 DAI principal added => interest accrued on balance.
      expect(balanceAfter).to.be.gt(
        balanceBefore.add(await convertToCurrencyDecimals(dai.address, '1'))
      );
      // Live (ceil) balance is consistent with the live index.
      expect(balanceAfter).to.eq(rayMulCeil(scaledAfter, liveIndex));
    });
  });

  // --------------------------------------------------------------------- //
  // mint / burn edge cases through the Pool                                //
  // --------------------------------------------------------------------- //
  describe('mint (ceil) / burn (floor) / full-repay clamp', () => {
    it('ceil mint: borrower debt balance is at or above the borrowed principal', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        users: [depositor, borrower],
      } = testEnv;

      const borrowAmount = await convertToCurrencyDecimals(dai.address, '777');
      await seedAndBorrow(pool, dai, weth, depositor, borrower, borrowAmount);

      const scaled = await variableDebtDai.scaledBalanceOf(borrower.address);
      const liveIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
      const balance = await variableDebtDai.balanceOf(borrower.address);

      // Ceil mint guarantees the borrower never owes LESS than the principal.
      expect(balance).to.be.gte(borrowAmount);
      // And balance is exactly the ceil of scaled * liveIndex.
      expect(balance).to.eq(rayMulCeil(scaled, liveIndex));
    });

    it('floor partial burn: a partial repay reduces scaled balance and leaves residual debt', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        users: [depositor, borrower],
      } = testEnv;

      const borrowAmount = await convertToCurrencyDecimals(dai.address, '10000');
      await seedAndBorrow(pool, dai, weth, depositor, borrower, borrowAmount);

      // Accrue interest so the live index > RAY (non-vacuous: partial burn floor matters).
      await increaseTime(365 * 24 * 60 * 60);

      const scaledBefore = await variableDebtDai.scaledBalanceOf(borrower.address);
      expect(scaledBefore).to.be.gt(0);

      // Fund the borrower to repay a partial chunk.
      await dai
        .connect(borrower.signer)
        ['mint(uint256)'](await convertToCurrencyDecimals(dai.address, '20000'));
      await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);

      const repayChunk = await convertToCurrencyDecimals(dai.address, '2000');
      await pool
        .connect(borrower.signer)
        .repay(dai.address, repayChunk, RateMode.Variable, borrower.address);

      // Index moved above RAY at the repay block (confirms accrual really happened).
      const liveIndex = await pool.getReserveNormalizedVariableDebt(dai.address);
      expect(liveIndex).to.be.gt(RAY);

      // Scaled balance strictly decreased but debt is NOT cleared (residual remains).
      const scaledAfter = await variableDebtDai.scaledBalanceOf(borrower.address);
      expect(scaledAfter).to.be.lt(scaledBefore);
      expect(scaledAfter).to.be.gt(0);
      expect(await variableDebtDai.balanceOf(borrower.address)).to.be.gt(0);
    });

    it('full-repay clamp: repay(MAX) zeroes both balanceOf and scaledBalanceOf with no dust', async () => {
      const {
        pool,
        dai,
        weth,
        variableDebtDai,
        users: [depositor, borrower],
      } = testEnv;

      const borrowAmount = await convertToCurrencyDecimals(dai.address, '8000');
      await seedAndBorrow(pool, dai, weth, depositor, borrower, borrowAmount);

      // Accrue interest so the closing repay must cover principal + accrued.
      await increaseTime(365 * 24 * 60 * 60);

      // Confirm interest actually accrued before relying on the clamp.
      await dai
        .connect(borrower.signer)
        ['mint(uint256)'](await convertToCurrencyDecimals(dai.address, '20000'));
      await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);

      const debtBeforeRepay = await variableDebtDai.balanceOf(borrower.address);
      expect(debtBeforeRepay).to.be.gt(borrowAmount); // interest accrued

      await pool
        .connect(borrower.signer)
        .repay(dai.address, MAX_UINT_AMOUNT, RateMode.Variable, borrower.address);

      // Full-repay clamp: no scaled dust survives.
      expect(await variableDebtDai.balanceOf(borrower.address)).to.eq(0);
      expect(await variableDebtDai.scaledBalanceOf(borrower.address)).to.eq(0);
      const [scaledUser, scaledSupply] = await variableDebtDai.getScaledUserBalanceAndSupply(
        borrower.address
      );
      expect(scaledUser).to.eq(0);
      // Borrower was the sole debtor: total scaled supply returns to zero too.
      expect(scaledSupply).to.eq(0);
      expect(await variableDebtDai.scaledTotalSupply()).to.eq(0);
    });
  });
});
