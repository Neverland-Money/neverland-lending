import { evmRevert, evmSnapshot } from '@aave/deploy-v3';
import { expect } from 'chai';
import { MAX_UINT_AMOUNT } from '../helpers/constants';
import { convertToCurrencyDecimals } from '../helpers/contracts-helpers';
import { ProtocolErrors, RateMode } from '../helpers/types';
import { makeSuite, SignerWithAddress, TestEnv } from './helpers/make-suite';

makeSuite('StableDebtToken: disabled Pool paths', (testEnv: TestEnv) => {
  const { STABLE_BORROWING_NOT_ENABLED } = ProtocolErrors;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let depositor: SignerWithAddress;
  let snapId: string;

  before(async () => {
    const { users, pool, dai, weth } = testEnv;
    [alice, bob, depositor] = users;

    const daiLiquidity = await convertToCurrencyDecimals(dai.address, '10000000');
    await dai.connect(depositor.signer)['mint(uint256)'](daiLiquidity);
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(depositor.signer).supply(dai.address, daiLiquidity, depositor.address, 0);

    const wethCollateral = await convertToCurrencyDecimals(weth.address, '1000');
    await weth.connect(alice.signer)['mint(address,uint256)'](alice.address, wethCollateral);
    await weth.connect(alice.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(alice.signer).supply(weth.address, wethCollateral, alice.address, 0);

    await dai.connect(alice.signer).approve(pool.address, MAX_UINT_AMOUNT);
  });

  beforeEach(async () => {
    snapId = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapId);
  });

  it('does not mint stable debt events through Pool stable borrow', async () => {
    const { pool, dai, stableDebtDai } = testEnv;
    const amount = await convertToCurrencyDecimals(dai.address, '100');

    await expect(
      pool.connect(alice.signer).borrow(dai.address, amount, RateMode.Stable, 0, alice.address)
    ).to.be.revertedWith(STABLE_BORROWING_NOT_ENABLED);

    expect(await stableDebtDai.balanceOf(alice.address)).to.be.eq(0);
  });

  it('keeps delegated stable borrow disabled after delegation approval', async () => {
    const { pool, dai, stableDebtDai } = testEnv;
    const amount = await convertToCurrencyDecimals(dai.address, '100');

    await stableDebtDai.connect(alice.signer).approveDelegation(bob.address, MAX_UINT_AMOUNT);

    await expect(
      pool.connect(bob.signer).borrow(dai.address, amount, RateMode.Stable, 0, alice.address)
    ).to.be.revertedWith(STABLE_BORROWING_NOT_ENABLED);

    expect(await stableDebtDai.balanceOf(alice.address)).to.be.eq(0);
    expect(await stableDebtDai.balanceOf(bob.address)).to.be.eq(0);
  });

  it('keeps stable repay disabled before stable debt accounting', async () => {
    const { pool, dai, stableDebtDai } = testEnv;
    const amount = await convertToCurrencyDecimals(dai.address, '1');

    await expect(
      pool.connect(alice.signer).repay(dai.address, amount, RateMode.Stable, alice.address)
    ).to.be.revertedWith(STABLE_BORROWING_NOT_ENABLED);

    expect(await stableDebtDai.balanceOf(alice.address)).to.be.eq(0);
  });
});
