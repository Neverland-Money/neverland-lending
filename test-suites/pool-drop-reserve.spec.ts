import { expect } from 'chai';
import { ZERO_ADDRESS } from '../helpers/constants';
import { ProtocolErrors } from '../helpers/types';
import { makeSuite, TestEnv } from './helpers/make-suite';

makeSuite('Pool: Drop Reserve disabled', (testEnv: TestEnv) => {
  it('pool admin cannot drop listed or zero-address reserves', async () => {
    const { configurator, dai } = testEnv;

    await expect(configurator.dropReserve(dai.address)).to.be.revertedWith(
      ProtocolErrors.OPERATION_NOT_SUPPORTED
    );

    await expect(configurator.dropReserve(ZERO_ADDRESS)).to.be.revertedWith(
      ProtocolErrors.OPERATION_NOT_SUPPORTED
    );
  });

  it('non-pool-admin callers remain blocked before the disabled-path revert', async () => {
    const {
      configurator,
      dai,
      users: [user],
    } = testEnv;

    await expect(configurator.connect(user.signer).dropReserve(dai.address)).to.be.revertedWith(
      ProtocolErrors.CALLER_NOT_POOL_ADMIN
    );
  });
});
