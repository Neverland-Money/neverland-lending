// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (utils/cryptography/ECDSA.sol)
pragma solidity ^0.8.0;

/**
 * @dev Elliptic Curve Digital Signature Algorithm operations.
 */
library ECDSA {
  /**
   * @dev Returns the address that signed a hashed message (`hash`) with
   * `signature` or reverts on malleable signatures.
   */
  function recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
    require(
      uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
      "ECDSA: invalid signature 's' value"
    );
    require(v == 27 || v == 28, "ECDSA: invalid signature 'v' value");

    address signer = ecrecover(hash, v, r, s);
    require(signer != address(0), 'ECDSA: invalid signature');

    return signer;
  }
}
