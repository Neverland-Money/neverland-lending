import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ZERO_ADDRESS } from '../helpers/constants';
import { ProtocolErrors } from '../helpers/types';
import { makeSuite, TestEnv } from './helpers/make-suite';

makeSuite('AToken: DelegationAwareAToken', (testEnv: TestEnv) => {
  let delegationAToken: any = {};
  let delegationERC20: any = {};

  it('Deploys a new MintableDelegationERC20 and a DelegationAwareAToken', async () => {
    const { pool } = testEnv;

    const delegationERC20Factory = await ethers.getContractFactory('MintableDelegationERC20');
    delegationERC20 = await delegationERC20Factory.deploy('DEL', 'DEL', '18');

    const delegationATokenFactory = await ethers.getContractFactory('DelegationAwareAToken');
    delegationAToken = await delegationATokenFactory.deploy(pool.address);
    await delegationAToken.initialize(
      pool.address,
      ZERO_ADDRESS,
      delegationERC20.address,
      ZERO_ADDRESS,
      '18',
      'aDEL',
      'aDEL',
      '0x10'
    );
  });

  it('Tries to delegate with the caller not being the Aave admin (revert expected)', async () => {
    const { users } = testEnv;

    await expect(
      delegationAToken.connect(users[1].signer).delegateUnderlyingTo(users[2].address)
    ).to.be.revertedWith(ProtocolErrors.CALLER_NOT_POOL_ADMIN);
  });

  it('Delegates to user 2', async () => {
    const { users } = testEnv;

    await expect(delegationAToken.delegateUnderlyingTo(users[2].address))
      .to.emit(delegationAToken, 'DelegateUnderlyingTo')
      .withArgs(users[2].address);

    const delegateeAddress = await delegationERC20.delegatee();

    expect(delegateeAddress).to.be.equal(users[2].address);
  });
});
