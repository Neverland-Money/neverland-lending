// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import {IERC20} from '../../dependencies/openzeppelin/contracts/IERC20.sol';
import {IPoolAddressesProvider} from '../../interfaces/IPoolAddressesProvider.sol';
import {ICreditDelegationToken} from '../../interfaces/ICreditDelegationToken.sol';
import {FlashLoanReceiverBase} from '../../flashloan/base/FlashLoanReceiverBase.sol';

contract MockFlashLoanReceiverEModeSwitch is FlashLoanReceiverBase {
  event EModeSwitched(uint8 indexed categoryId);

  constructor(IPoolAddressesProvider provider) FlashLoanReceiverBase(provider) {}

  function supply(address asset, uint256 amount) external {
    IERC20(asset).approve(address(POOL), amount);
    POOL.supply(asset, amount, address(this), 0);
  }

  function approveDelegation(address debtToken, address delegatee, uint256 amount) external {
    ICreditDelegationToken(debtToken).approveDelegation(delegatee, amount);
  }

  function executeOperation(
    address[] memory,
    uint256[] memory,
    uint256[] memory,
    address,
    bytes memory params
  ) public override returns (bool) {
    uint8 categoryId = abi.decode(params, (uint8));
    POOL.setUserEMode(categoryId);
    emit EModeSwitched(categoryId);
    return true;
  }
}
