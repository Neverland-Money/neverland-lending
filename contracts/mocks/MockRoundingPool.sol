// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {IPoolAddressesProvider} from '../interfaces/IPoolAddressesProvider.sol';
import {IAToken} from '../interfaces/IAToken.sol';
import {IVariableDebtToken} from '../interfaces/IVariableDebtToken.sol';

contract MockRoundingAddressesProvider {
  address private _oracle;

  function setPriceOracle(address oracle) external {
    _oracle = oracle;
  }

  function getPriceOracle() external view returns (address) {
    return _oracle;
  }
}

contract MockRoundingPool {
  IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;

  uint256 private _liquidityIndex;
  uint256 private _variableBorrowIndex;

  constructor(
    IPoolAddressesProvider provider,
    uint256 liquidityIndex,
    uint256 variableBorrowIndex
  ) {
    ADDRESSES_PROVIDER = provider;
    _liquidityIndex = liquidityIndex;
    _variableBorrowIndex = variableBorrowIndex;
  }

  function setLiquidityIndex(uint256 liquidityIndex) external {
    _liquidityIndex = liquidityIndex;
  }

  function setVariableBorrowIndex(uint256 variableBorrowIndex) external {
    _variableBorrowIndex = variableBorrowIndex;
  }

  function getReserveNormalizedIncome(address) external view returns (uint256) {
    return _liquidityIndex;
  }

  function getReserveNormalizedVariableDebt(address) external view returns (uint256) {
    return _variableBorrowIndex;
  }

  function finalizeTransfer(address, address, address, uint256, uint256, uint256) external {}

  function callATokenMint(
    IAToken token,
    address caller,
    address onBehalfOf,
    uint256 amount,
    uint256 index
  ) external returns (bool) {
    return token.mint(caller, onBehalfOf, amount, index);
  }

  function callATokenBurn(
    IAToken token,
    address from,
    address receiverOfUnderlying,
    uint256 amount,
    uint256 index
  ) external {
    token.burn(from, receiverOfUnderlying, amount, index);
  }

  function callATokenMintToTreasury(IAToken token, uint256 amount, uint256 index) external {
    token.mintToTreasury(amount, index);
  }

  function callATokenTransferOnLiquidation(
    IAToken token,
    address from,
    address to,
    uint256 value
  ) external {
    token.transferOnLiquidation(from, to, value);
  }

  function callVariableDebtMint(
    IVariableDebtToken token,
    address user,
    address onBehalfOf,
    uint256 amount,
    uint256 index
  ) external returns (bool, uint256) {
    return token.mint(user, onBehalfOf, amount, index);
  }

  function callVariableDebtBurn(
    IVariableDebtToken token,
    address from,
    uint256 amount,
    uint256 index
  ) external returns (uint256) {
    return token.burn(from, amount, index);
  }
}
