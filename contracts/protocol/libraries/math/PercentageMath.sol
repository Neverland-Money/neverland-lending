// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

/**
 * @title PercentageMath library
 * @author Aave
 * @notice Provides functions to perform percentage calculations
 * @dev Percentages use 2 decimals of precision. `percentMul` and `percentDiv`
 *      round half up; floor and ceil variants round in their named direction.
 */
library PercentageMath {
  // Maximum percentage factor (100.00%)
  uint256 internal constant PERCENTAGE_FACTOR = 1e4;

  // Half percentage factor (50.00%)
  uint256 internal constant HALF_PERCENTAGE_FACTOR = 0.5e4;

  /**
   * @notice Executes a percentage multiplication
   * @dev Rounds half up: values >= .5 round up, otherwise down.
   * @dev assembly optimized for improved gas savings, see https://twitter.com/transmissions11/status/1451131036377571328
   * @param value The value of which the percentage needs to be calculated
   * @param percentage The percentage of the value to be calculated
   * @return result value percentmul percentage
   */
  function percentMul(uint256 value, uint256 percentage) internal pure returns (uint256 result) {
    // to avoid overflow, value <= (type(uint256).max - HALF_PERCENTAGE_FACTOR) / percentage
    assembly {
      if iszero(
        or(
          iszero(percentage),
          iszero(gt(value, div(sub(not(0), HALF_PERCENTAGE_FACTOR), percentage)))
        )
      ) {
        revert(0, 0)
      }

      result := div(add(mul(value, percentage), HALF_PERCENTAGE_FACTOR), PERCENTAGE_FACTOR)
    }
  }

  /**
   * @notice Executes a percentage multiplication, rounded up.
   */
  function percentMulCeil(
    uint256 value,
    uint256 percentage
  ) internal pure returns (uint256 result) {
    // to avoid overflow, value <= type(uint256).max / percentage
    assembly {
      if iszero(or(iszero(percentage), iszero(gt(value, div(not(0), percentage))))) {
        revert(0, 0)
      }

      let product := mul(value, percentage)
      result := add(
        div(product, PERCENTAGE_FACTOR),
        iszero(iszero(mod(product, PERCENTAGE_FACTOR)))
      )
    }
  }

  /**
   * @notice Executes a percentage multiplication, rounded down.
   */
  function percentMulFloor(
    uint256 value,
    uint256 percentage
  ) internal pure returns (uint256 result) {
    // to avoid overflow, value <= type(uint256).max / percentage
    assembly {
      if iszero(or(iszero(percentage), iszero(gt(value, div(not(0), percentage))))) {
        revert(0, 0)
      }

      result := div(mul(value, percentage), PERCENTAGE_FACTOR)
    }
  }

  /**
   * @notice Executes a percentage division
   * @dev Rounds half up: values >= .5 round up, otherwise down.
   * @dev assembly optimized for improved gas savings, see https://twitter.com/transmissions11/status/1451131036377571328
   * @param value The value of which the percentage needs to be calculated
   * @param percentage The percentage of the value to be calculated
   * @return result value percentdiv percentage
   */
  function percentDiv(uint256 value, uint256 percentage) internal pure returns (uint256 result) {
    // to avoid overflow, value <= (type(uint256).max - halfPercentage) / PERCENTAGE_FACTOR
    assembly {
      if or(
        iszero(percentage),
        iszero(iszero(gt(value, div(sub(not(0), div(percentage, 2)), PERCENTAGE_FACTOR))))
      ) {
        revert(0, 0)
      }

      result := div(add(mul(value, PERCENTAGE_FACTOR), div(percentage, 2)), percentage)
    }
  }

  /**
   * @notice Executes a percentage division, rounded down.
   */
  function percentDivFloor(
    uint256 value,
    uint256 percentage
  ) internal pure returns (uint256 result) {
    // to avoid overflow, value <= type(uint256).max / PERCENTAGE_FACTOR
    assembly {
      if or(iszero(percentage), iszero(iszero(gt(value, div(not(0), PERCENTAGE_FACTOR))))) {
        revert(0, 0)
      }

      result := div(mul(value, PERCENTAGE_FACTOR), percentage)
    }
  }

  /**
   * @notice Executes a percentage division, rounded up.
   */
  function percentDivCeil(
    uint256 value,
    uint256 percentage
  ) internal pure returns (uint256 result) {
    // to avoid overflow, value <= type(uint256).max / PERCENTAGE_FACTOR
    assembly {
      if or(iszero(percentage), iszero(iszero(gt(value, div(not(0), PERCENTAGE_FACTOR))))) {
        revert(0, 0)
      }

      let val := mul(value, PERCENTAGE_FACTOR)
      result := add(div(val, percentage), iszero(iszero(mod(val, percentage))))
    }
  }
}
