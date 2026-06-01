// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import {WadRayMath} from '../protocol/libraries/math/WadRayMath.sol';
import {PercentageMath} from '../protocol/libraries/math/PercentageMath.sol';
import {TokenMath} from '../protocol/libraries/helpers/TokenMath.sol';

contract MathPropertyHarness {
  using WadRayMath for uint256;
  using PercentageMath for uint256;

  function rayMul(uint256 a, uint256 b) external pure returns (uint256) {
    return a.rayMul(b);
  }

  function rayMulFloor(uint256 a, uint256 b) external pure returns (uint256) {
    return a.rayMulFloor(b);
  }

  function rayMulCeil(uint256 a, uint256 b) external pure returns (uint256) {
    return a.rayMulCeil(b);
  }

  function rayDiv(uint256 a, uint256 b) external pure returns (uint256) {
    return a.rayDiv(b);
  }

  function rayDivFloor(uint256 a, uint256 b) external pure returns (uint256) {
    return a.rayDivFloor(b);
  }

  function rayDivCeil(uint256 a, uint256 b) external pure returns (uint256) {
    return a.rayDivCeil(b);
  }

  function percentMul(uint256 value, uint256 percentage) external pure returns (uint256) {
    return value.percentMul(percentage);
  }

  function percentMulFloor(uint256 value, uint256 percentage) external pure returns (uint256) {
    return value.percentMulFloor(percentage);
  }

  function percentMulCeil(uint256 value, uint256 percentage) external pure returns (uint256) {
    return value.percentMulCeil(percentage);
  }

  function percentDiv(uint256 value, uint256 percentage) external pure returns (uint256) {
    return value.percentDiv(percentage);
  }

  function percentDivFloor(uint256 value, uint256 percentage) external pure returns (uint256) {
    return value.percentDivFloor(percentage);
  }

  function percentDivCeil(uint256 value, uint256 percentage) external pure returns (uint256) {
    return value.percentDivCeil(percentage);
  }

  function getATokenMintScaledAmount(
    uint256 amount,
    uint256 index
  ) external pure returns (uint256) {
    return TokenMath.getATokenMintScaledAmount(amount, index);
  }

  function getATokenBurnScaledAmount(
    uint256 amount,
    uint256 index
  ) external pure returns (uint256) {
    return TokenMath.getATokenBurnScaledAmount(amount, index);
  }

  function getATokenTransferScaledAmount(
    uint256 amount,
    uint256 index
  ) external pure returns (uint256) {
    return TokenMath.getATokenTransferScaledAmount(amount, index);
  }

  function getATokenBalance(uint256 scaled, uint256 index) external pure returns (uint256) {
    return TokenMath.getATokenBalance(scaled, index);
  }

  function getVTokenMintScaledAmount(
    uint256 amount,
    uint256 index
  ) external pure returns (uint256) {
    return TokenMath.getVTokenMintScaledAmount(amount, index);
  }

  function getVTokenBurnScaledAmount(
    uint256 amount,
    uint256 index
  ) external pure returns (uint256) {
    return TokenMath.getVTokenBurnScaledAmount(amount, index);
  }

  function getVTokenBalance(uint256 scaled, uint256 index) external pure returns (uint256) {
    return TokenMath.getVTokenBalance(scaled, index);
  }
}
