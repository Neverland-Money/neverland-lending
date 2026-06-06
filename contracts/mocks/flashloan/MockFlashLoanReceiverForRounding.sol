// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import {IERC20} from '../../dependencies/openzeppelin/contracts/IERC20.sol';
import {IPoolAddressesProvider} from '../../interfaces/IPoolAddressesProvider.sol';
import {FlashLoanSimpleReceiverBase} from '../../flashloan/base/FlashLoanSimpleReceiverBase.sol';

/**
 * @title MockFlashLoanReceiverForRounding
 * @notice Test-only, non-minting, pre-funded flashloan-simple receiver used to measure the
 *         exact flashloan premium charged per loop. Unlike MockSimpleFlashLoanReceiver this
 *         contract does NOT mint the premium to itself, so the receiver's net underlying
 *         balance moves by exactly `-premium` across a flashLoanSimple. That lets a test read
 *         the per-loop premium directly off the balance delta and assert it equals
 *         percentMulCeil(amount, FLASHLOAN_PREMIUM_TOTAL) with zero cumulative drift.
 *         The test must pre-fund this contract with enough underlying to cover the premium.
 */
contract MockFlashLoanReceiverForRounding is FlashLoanSimpleReceiverBase {
  event ExecutedFlashLoan(address asset, uint256 amount, uint256 premium);

  bool internal _returnFalse;

  constructor(IPoolAddressesProvider provider) FlashLoanSimpleReceiverBase(provider) {}

  function setReturnFalse(bool returnFalse) external {
    _returnFalse = returnFalse;
  }

  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address, // initiator
    bytes calldata // params
  ) external override returns (bool) {
    uint256 amountToReturn = amount + premium;
    require(
      IERC20(asset).balanceOf(address(this)) >= amountToReturn,
      'MockFlashLoanReceiverForRounding: insufficient pre-funded balance'
    );
    IERC20(asset).approve(address(POOL), amountToReturn);
    emit ExecutedFlashLoan(asset, amount, premium);
    return !_returnFalse;
  }
}
