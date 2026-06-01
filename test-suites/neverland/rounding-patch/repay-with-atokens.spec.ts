import { evmRevert, evmSnapshot } from '@aave/deploy-v3';
import { expect } from 'chai';
import { MAX_UINT_AMOUNT } from '../../../helpers/constants';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../../../helpers/types';
import { makeSuite, TestEnv } from '../../helpers/make-suite';

makeSuite('Neverland rounding patch: repay with aTokens', (testEnv: TestEnv) => {
  let snapId: string;

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  it('rejects max repayWithATokens when the payer has zero matching aTokens', async () => {
    const {
      users: [depositor, borrower],
      pool,
      dai,
      aDai,
      weth,
    } = testEnv;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '10000');
    const wethCollateral = await convertToCurrencyDecimals(weth.address, '10');
    const borrowAmount = await convertToCurrencyDecimals(dai.address, '100');

    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, '0');

    await weth.connect(borrower.signer)['mint(address,uint256)'](borrower.address, wethCollateral);
    await weth.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(borrower.signer).supply(weth.address, wethCollateral, borrower.address, '0');

    await pool
      .connect(borrower.signer)
      .borrow(dai.address, borrowAmount, RateMode.Variable, '0', borrower.address);

    expect(await aDai.balanceOf(borrower.address)).to.eq(0);
    await expect(
      pool
        .connect(borrower.signer)
        .repayWithATokens(dai.address, MAX_UINT_AMOUNT, RateMode.Variable)
    ).to.be.revertedWith(ProtocolErrors.INVALID_AMOUNT);
  });
});
