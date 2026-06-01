import { BigNumber, Signer } from 'ethers';
import { ethers } from 'hardhat';

export const topUpNonPayableWithEther = async (
  holder: Signer,
  accounts: string[],
  amount: BigNumber
) => {
  let selfdestructContract;
  const factory = await ethers.getContractFactory('SelfdestructTransfer', holder);
  for (const account of accounts) {
    selfdestructContract = await factory.deploy();
    await selfdestructContract.deployed();
    await selfdestructContract.destroyAndTransfer(account, {
      value: amount,
    });
  }
};
