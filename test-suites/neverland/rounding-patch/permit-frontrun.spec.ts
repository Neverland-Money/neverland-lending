/*
 * Neverland rounding patch: permit front-run tolerance (audit finding #25).
 *
 * supplyWithPermit / repayWithPermit must not revert just because the permit was
 * already consumed (e.g. front-run by a relayer that submitted the same signature
 * first). The permit call is wrapped in try/catch so a spent-nonce revert is
 * swallowed; the user's intended allowance is already in place, so the action
 * proceeds. A genuinely-missing allowance still reverts downstream in
 * executeSupply/executeRepay (the transferFrom), so the catch hides nothing real.
 *
 * VARIABLE RATE ONLY. Stable rate is disabled by the patch.
 */

import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { HARDHAT_CHAINID, MAX_UINT_AMOUNT } from '../../../helpers/constants';
import {
  buildPermitParams,
  convertToCurrencyDecimals,
  getSignatureFromTypedData,
} from '../../../helpers/contracts-helpers';
import { RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';
import { getTestWallets } from '../../helpers/utils/wallets';

declare var hre: HardhatRuntimeEnvironment;

const EIP712_REVISION = '1';

makeSuite('Neverland rounding patch: permit front-run tolerance', (testEnv: TestEnv) => {
  let snap: string;
  let testWallets: { secretKey: string; balance: string }[];

  before(async () => {
    testWallets = getTestWallets() as unknown as { secretKey: string; balance: string }[];
  });

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  const signUnderlyingPermit = async (
    token: any,
    owner: string,
    ownerPrivateKey: string,
    spender: string,
    amount: BigNumber
  ) => {
    const chainId = hre.network.config.chainId || HARDHAT_CHAINID;
    const nonce = (await token.nonces(owner)).toNumber();
    const deadline = MAX_UINT_AMOUNT;
    const msgParams = buildPermitParams(
      chainId,
      token.address,
      EIP712_REVISION,
      await token.name(),
      owner,
      spender,
      nonce,
      deadline,
      amount.toString()
    );
    return { deadline, ...getSignatureFromTypedData(ownerPrivateKey, msgParams) };
  };

  const seedDaiVariableDebt = async (borrowDai: string = '100') => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      weth,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '100000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '100');
    const borrowAmount = await convertToCurrencyDecimals(dai.address, borrowDai);

    await waitForTx(await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity));
    await waitForTx(await dai.connect(depositor.signer).approve(pool.address, daiLiquidity));
    await waitForTx(
      await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0')
    );

    await waitForTx(
      await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral)
    );
    await waitForTx(await weth.connect(borrower.signer).approve(pool.address, wethCollateral));
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

    return { depositor, borrower, borrowAmount };
  };

  it('supplyWithPermit tolerates a front-run permit that already set the Pool allowance', async () => {
    const {
      users: [supplier, relayer],
      pool,
      dai,
      aDai,
    } = testEnv;
    const supplyAmount = await convertToCurrencyDecimals(dai.address, '100');
    const permit = await signUnderlyingPermit(
      dai.connect(supplier.signer),
      supplier.address,
      testWallets[1].secretKey,
      pool.address,
      supplyAmount
    );

    await waitForTx(await dai.connect(supplier.signer)['mint(uint256)'](supplyAmount));
    const supplierDaiBefore = await dai.balanceOf(supplier.address);
    const supplierADaiBefore = await aDai.balanceOf(supplier.address);

    // Someone front-runs the permit (relayer submits the same signature first).
    await waitForTx(
      await dai
        .connect(relayer.signer)
        .permit(
          supplier.address,
          pool.address,
          supplyAmount,
          permit.deadline,
          permit.v,
          permit.r,
          permit.s
        )
    );
    const nonceAfterFrontrun = await dai.nonces(supplier.address);
    expect(await dai.allowance(supplier.address, pool.address)).to.eq(supplyAmount);

    // The user's supplyWithPermit must still succeed despite the now-spent permit.
    await waitForTx(
      await pool
        .connect(supplier.signer)
        .supplyWithPermit(
          dai.address,
          supplyAmount,
          supplier.address,
          '0',
          permit.deadline,
          permit.v,
          permit.r,
          permit.s
        )
    );

    expect(await dai.nonces(supplier.address)).to.eq(nonceAfterFrontrun); // not consumed twice
    expect(supplierDaiBefore.sub(await dai.balanceOf(supplier.address))).to.eq(supplyAmount);
    expect((await aDai.balanceOf(supplier.address)).sub(supplierADaiBefore)).to.eq(supplyAmount);
    expect(await dai.allowance(supplier.address, pool.address)).to.eq(0);
  });

  it('supplyWithPermit still reverts on a bad permit when no allowance exists', async () => {
    const {
      users: [supplier],
      pool,
      dai,
    } = testEnv;
    const supplyAmount = await convertToCurrencyDecimals(dai.address, '100');

    await waitForTx(await dai.connect(supplier.signer)['mint(uint256)'](supplyAmount));
    const supplierDaiBefore = await dai.balanceOf(supplier.address);

    await expect(
      pool
        .connect(supplier.signer)
        .supplyWithPermit(
          dai.address,
          supplyAmount,
          supplier.address,
          '0',
          MAX_UINT_AMOUNT,
          0,
          constants.HashZero,
          constants.HashZero
        )
    ).to.be.reverted;
    expect(await dai.balanceOf(supplier.address)).to.eq(supplierDaiBefore);
    expect(await dai.allowance(supplier.address, pool.address)).to.eq(0);
  });

  it('repayWithPermit tolerates a front-run permit that already set the Pool allowance', async () => {
    const {
      users: [, borrower, relayer],
      pool,
      dai,
      variableDebtDai,
    } = testEnv;
    const { borrowAmount } = await seedDaiVariableDebt('100');
    const debtBefore = await variableDebtDai.balanceOf(borrower.address);
    const borrowerDaiBefore = await dai.balanceOf(borrower.address);
    const permit = await signUnderlyingPermit(
      dai.connect(borrower.signer),
      borrower.address,
      testWallets[2].secretKey,
      pool.address,
      borrowAmount
    );

    await waitForTx(
      await dai
        .connect(relayer.signer)
        .permit(
          borrower.address,
          pool.address,
          borrowAmount,
          permit.deadline,
          permit.v,
          permit.r,
          permit.s
        )
    );
    const nonceAfterFrontrun = await dai.nonces(borrower.address);
    expect(await dai.allowance(borrower.address, pool.address)).to.eq(borrowAmount);

    await waitForTx(
      await pool
        .connect(borrower.signer)
        .repayWithPermit(
          dai.address,
          borrowAmount,
          RateMode.Variable,
          borrower.address,
          permit.deadline,
          permit.v,
          permit.r,
          permit.s
        )
    );

    expect(await dai.nonces(borrower.address)).to.eq(nonceAfterFrontrun); // not consumed twice
    expect(borrowerDaiBefore.sub(await dai.balanceOf(borrower.address))).to.eq(borrowAmount);
    expect(await variableDebtDai.balanceOf(borrower.address)).to.be.lt(debtBefore);
    expect(await dai.allowance(borrower.address, pool.address)).to.eq(0);
  });

  it('repayWithPermit still reverts on a bad permit when no allowance exists', async () => {
    const {
      users: [, borrower],
      pool,
      dai,
      variableDebtDai,
    } = testEnv;
    const { borrowAmount } = await seedDaiVariableDebt('100');
    const borrowerDaiBefore = await dai.balanceOf(borrower.address);
    const scaledDebtBefore = await variableDebtDai.scaledBalanceOf(borrower.address);

    await expect(
      pool
        .connect(borrower.signer)
        .repayWithPermit(
          dai.address,
          borrowAmount,
          RateMode.Variable,
          borrower.address,
          MAX_UINT_AMOUNT,
          0,
          constants.HashZero,
          constants.HashZero
        )
    ).to.be.reverted;
    expect(await dai.balanceOf(borrower.address)).to.eq(borrowerDaiBefore);
    expect(await variableDebtDai.scaledBalanceOf(borrower.address)).to.eq(scaledDebtBefore);
    expect(await dai.allowance(borrower.address, pool.address)).to.eq(0);
  });
});
