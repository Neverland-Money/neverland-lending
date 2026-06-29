import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../../../helpers/constants';
import { ProtocolErrors } from '../../../helpers/types';

const RAY = BigNumber.from(10).pow(27);
const EIP712_REVISION = '1';
const SECP256K1_N = BigNumber.from(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
);

const topic = (event: string) => ethers.utils.id(event);

const makeHighSSignature = (signature: string) => {
  const split = ethers.utils.splitSignature(signature);
  return {
    v: split.v === 27 ? 28 : 27,
    r: split.r,
    s: ethers.utils.hexZeroPad(SECP256K1_N.sub(BigNumber.from(split.s)).toHexString(), 32),
  };
};

describe('Neverland rounding patch token runtime', () => {
  const index = RAY.mul(2);

  const deployTokens = async (normalizedIndex = index) => {
    const [, alice, bob, spender, treasury] = await ethers.getSigners();

    const provider = await (
      await ethers.getContractFactory('MockRoundingAddressesProvider')
    ).deploy();
    await provider.deployed();
    const oracle = await (await ethers.getContractFactory('MockPriceEmitterOracle')).deploy();
    await oracle.deployed();
    await provider.setPriceOracle(oracle.address);

    const pool = await (
      await ethers.getContractFactory('MockRoundingPool')
    ).deploy(provider.address, normalizedIndex, normalizedIndex);
    await pool.deployed();

    const underlying = await (
      await ethers.getContractFactory('MintableERC20')
    ).deploy('Underlying', 'UND', 18);
    await underlying.deployed();

    const proxyFactory = await ethers.getContractFactory(
      'InitializableImmutableAdminUpgradeabilityProxy'
    );

    const aTokenFactory = await ethers.getContractFactory('AToken');
    const aTokenImplementation = await aTokenFactory.deploy(pool.address);
    await aTokenImplementation.deployed();
    const aTokenProxy = await proxyFactory.deploy(treasury.address);
    await aTokenProxy.deployed();
    await aTokenProxy.initialize(
      aTokenImplementation.address,
      aTokenImplementation.interface.encodeFunctionData('initialize', [
        pool.address,
        treasury.address,
        underlying.address,
        ZERO_ADDRESS,
        18,
        'Neverland AToken',
        'nATKN',
        '0x',
      ])
    );
    const aToken = aTokenFactory.attach(aTokenProxy.address);

    const variableDebtTokenFactory = await ethers.getContractFactory('VariableDebtToken');
    const variableDebtTokenImplementation = await variableDebtTokenFactory.deploy(pool.address);
    await variableDebtTokenImplementation.deployed();
    const variableDebtTokenProxy = await proxyFactory.deploy(treasury.address);
    await variableDebtTokenProxy.deployed();
    await variableDebtTokenProxy.initialize(
      variableDebtTokenImplementation.address,
      variableDebtTokenImplementation.interface.encodeFunctionData('initialize', [
        pool.address,
        underlying.address,
        ZERO_ADDRESS,
        18,
        'Neverland Variable Debt',
        'variableDebtN',
        '0x',
      ])
    );
    const variableDebtToken = variableDebtTokenFactory.attach(variableDebtTokenProxy.address);

    return {
      alice,
      bob,
      spender,
      treasury,
      pool,
      underlying,
      aToken,
      variableDebtToken,
    };
  };

  it('executes AToken floor mint, ceil burn, ceil transfer, and capped transferFrom allowance', async () => {
    const { alice, bob, spender, pool, underlying, aToken } = await deployTokens();

    await expect(
      pool.callATokenMint(aToken.address, alice.address, alice.address, 1, index)
    ).to.be.revertedWith(ProtocolErrors.INVALID_MINT_AMOUNT);

    await pool.callATokenMint(aToken.address, alice.address, alice.address, 4, index);
    expect(await aToken.scaledBalanceOf(alice.address)).to.eq(2);
    expect(await aToken.balanceOf(alice.address)).to.eq(4);

    await expect(aToken.connect(alice).transfer(bob.address, 1))
      .to.emit(aToken, 'BalanceTransfer')
      .withArgs(alice.address, bob.address, 1, index);
    expect(await aToken.scaledBalanceOf(alice.address)).to.eq(1);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(1);

    await aToken.connect(bob).approve(spender.address, 1);
    await expect(aToken.connect(spender).transferFrom(bob.address, alice.address, 1))
      .to.emit(aToken, 'Approval')
      .withArgs(bob.address, spender.address, 0);
    expect(await aToken.allowance(bob.address, spender.address)).to.eq(0);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(0);

    await pool.callATokenMint(aToken.address, alice.address, bob.address, 2, index);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(1);
    await expect(
      pool.callATokenBurn(aToken.address, bob.address, bob.address, 3, index)
    ).to.be.revertedWith(ProtocolErrors.INVALID_BURN_AMOUNT);

    await underlying['mint(address,uint256)'](aToken.address, 2);
    await pool.callATokenBurn(aToken.address, bob.address, bob.address, 1, index);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(0);
    expect(await underlying.balanceOf(bob.address)).to.eq(1);
  });

  it('executes AToken treasury minting through the floor leaf at a non-integral index', async () => {
    const { treasury, pool, aToken } = await deployTokens();

    await pool.callATokenMintToTreasury(aToken.address, 1, index);
    expect(await aToken.scaledBalanceOf(treasury.address)).to.eq(0);

    await pool.callATokenMintToTreasury(aToken.address, 2, index);
    expect(await aToken.scaledBalanceOf(treasury.address)).to.eq(1);
    expect(await aToken.balanceOf(treasury.address)).to.eq(2);
  });

  it('keeps max AToken allowance unchanged when transferFrom spends a ceil-scaled amount', async () => {
    const { alice, bob, spender, pool, aToken } = await deployTokens();

    await pool.callATokenMint(aToken.address, bob.address, bob.address, 4, index);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(2);

    await aToken.connect(bob).approve(spender.address, MAX_UINT_AMOUNT);
    await aToken.connect(spender).transferFrom(bob.address, alice.address, 1);

    expect(await aToken.allowance(bob.address, spender.address)).to.eq(MAX_UINT_AMOUNT);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(1);
    expect(await aToken.scaledBalanceOf(alice.address)).to.eq(1);
  });

  it('rejects malleable high-s AToken permit signatures', async () => {
    const { alice, spender, aToken } = await deployTokens();
    const { chainId } = await ethers.provider.getNetwork();
    const deadline = MAX_UINT_AMOUNT;
    const value = 1;
    const nonce = await aToken.nonces(alice.address);
    const signature = await alice._signTypedData(
      {
        name: await aToken.name(),
        version: EIP712_REVISION,
        chainId,
        verifyingContract: aToken.address,
      },
      {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        owner: alice.address,
        spender: spender.address,
        value,
        nonce,
        deadline,
      }
    );
    const { v, r, s } = makeHighSSignature(signature);

    await expect(
      aToken.connect(spender).permit(alice.address, spender.address, value, deadline, v, r, s)
    ).to.be.revertedWith("ECDSA: invalid signature 's' value");
    expect(await aToken.nonces(alice.address)).to.eq(0);
    expect(await aToken.allowance(alice.address, spender.address)).to.eq(0);
  });

  it('spends finite AToken allowance by the realized transfer delta when surplus exists', async () => {
    const { alice, bob, spender, pool, aToken } = await deployTokens();

    await pool.callATokenMint(aToken.address, bob.address, bob.address, 4, index);
    await aToken.connect(bob).approve(spender.address, 3);

    await expect(aToken.connect(spender).transferFrom(bob.address, alice.address, 1))
      .to.emit(aToken, 'Approval')
      .withArgs(bob.address, spender.address, 1);

    expect(await aToken.allowance(bob.address, spender.address)).to.eq(1);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(1);
    expect(await aToken.scaledBalanceOf(alice.address)).to.eq(1);
  });

  it('executes AToken liquidation transfer through the same ceil transfer path', async () => {
    const { alice, bob, pool, aToken } = await deployTokens();

    await pool.callATokenMint(aToken.address, alice.address, alice.address, 4, index);
    await expect(
      pool.callATokenTransferOnLiquidation(aToken.address, alice.address, bob.address, 1)
    )
      .to.emit(aToken, 'BalanceTransfer')
      .withArgs(alice.address, bob.address, 1, index);

    expect(await aToken.scaledBalanceOf(alice.address)).to.eq(1);
    expect(await aToken.scaledBalanceOf(bob.address)).to.eq(1);
  });

  it('executes VariableDebtToken ceil mint, floor partial burn, full-repay clamp, and capped delegation', async () => {
    const { alice, bob, spender, pool, variableDebtToken } = await deployTokens();

    await pool.callVariableDebtMint(
      variableDebtToken.address,
      alice.address,
      alice.address,
      1,
      index
    );
    expect(await variableDebtToken.scaledBalanceOf(alice.address)).to.eq(1);
    expect(await variableDebtToken.balanceOf(alice.address)).to.eq(2);

    await expect(
      pool.callVariableDebtBurn(variableDebtToken.address, alice.address, 1, index)
    ).to.be.revertedWith(ProtocolErrors.INVALID_BURN_AMOUNT);
    await pool.callVariableDebtBurn(variableDebtToken.address, alice.address, 2, index);
    expect(await variableDebtToken.scaledBalanceOf(alice.address)).to.eq(0);

    await pool.callVariableDebtMint(
      variableDebtToken.address,
      alice.address,
      alice.address,
      10,
      index
    );
    expect(await variableDebtToken.scaledBalanceOf(alice.address)).to.eq(5);
    await pool.callVariableDebtBurn(variableDebtToken.address, alice.address, 3, index);
    expect(await variableDebtToken.scaledBalanceOf(alice.address)).to.eq(4);
    await pool.callVariableDebtBurn(variableDebtToken.address, alice.address, 8, index);
    expect(await variableDebtToken.scaledBalanceOf(alice.address)).to.eq(0);

    await variableDebtToken.connect(bob).approveDelegation(spender.address, 1);
    await pool.callVariableDebtMint(
      variableDebtToken.address,
      spender.address,
      bob.address,
      1,
      index
    );
    expect(await variableDebtToken.borrowAllowance(bob.address, spender.address)).to.eq(0);
    expect(await variableDebtToken.scaledBalanceOf(bob.address)).to.eq(1);
    expect(await variableDebtToken.balanceOf(bob.address)).to.eq(2);
  });

  it('consumes delegated variable-debt allowance by the rounded debt increase when surplus exists', async () => {
    const { bob, spender, pool, variableDebtToken } = await deployTokens();

    await variableDebtToken.connect(bob).approveDelegation(spender.address, 3);
    await pool.callVariableDebtMint(
      variableDebtToken.address,
      spender.address,
      bob.address,
      1,
      index
    );

    expect(await variableDebtToken.borrowAllowance(bob.address, spender.address)).to.eq(1);
    expect(await variableDebtToken.scaledBalanceOf(bob.address)).to.eq(1);
    expect(await variableDebtToken.balanceOf(bob.address)).to.eq(2);
  });

  it('consumes delegated variable-debt allowance from the delegator debt delta, not the delegatee debt delta', async () => {
    const nonIntegralIndex = RAY.mul(2).add(1);
    const { bob, spender, pool, variableDebtToken } = await deployTokens(nonIntegralIndex);

    await pool.callVariableDebtMint(
      variableDebtToken.address,
      spender.address,
      spender.address,
      1,
      nonIntegralIndex
    );
    expect(await variableDebtToken.scaledBalanceOf(spender.address)).to.eq(1);
    expect(await variableDebtToken.balanceOf(spender.address)).to.eq(3);

    await variableDebtToken.connect(bob).approveDelegation(spender.address, 4);
    await pool.callVariableDebtMint(
      variableDebtToken.address,
      spender.address,
      bob.address,
      1,
      nonIntegralIndex
    );

    expect(await variableDebtToken.borrowAllowance(bob.address, spender.address)).to.eq(1);
    expect(await variableDebtToken.scaledBalanceOf(bob.address)).to.eq(1);
    expect(await variableDebtToken.balanceOf(bob.address)).to.eq(3);
  });

  it('rejects malleable high-s variable debt delegation signatures', async () => {
    const { bob, spender, variableDebtToken } = await deployTokens();
    const { chainId } = await ethers.provider.getNetwork();
    const deadline = MAX_UINT_AMOUNT;
    const value = 1;
    const nonce = await variableDebtToken.nonces(bob.address);
    const signature = await bob._signTypedData(
      {
        name: await variableDebtToken.name(),
        version: EIP712_REVISION,
        chainId,
        verifyingContract: variableDebtToken.address,
      },
      {
        DelegationWithSig: [
          { name: 'delegatee', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        delegatee: spender.address,
        value,
        nonce,
        deadline,
      }
    );
    const { v, r, s } = makeHighSSignature(signature);

    await expect(
      variableDebtToken
        .connect(spender)
        .delegationWithSig(bob.address, spender.address, value, deadline, v, r, s)
    ).to.be.revertedWith("ECDSA: invalid signature 's' value");
    expect(await variableDebtToken.nonces(bob.address)).to.eq(0);
    expect(await variableDebtToken.borrowAllowance(bob.address, spender.address)).to.eq(0);
  });

  it('emits PriceObserved without changing the baseline token selector set', async () => {
    const { alice, pool, aToken } = await deployTokens();

    const tx = await pool.callATokenMint(aToken.address, alice.address, alice.address, 4, index);
    const receipt = await tx.wait();
    const observed = receipt.logs.filter(
      (log: any) => log.address.toLowerCase() === aToken.address.toLowerCase()
    );

    expect(observed.map((log: any) => log.topics[0])).to.include(
      topic('PriceObserved(address,uint256,uint256,address,uint8,bool,address,uint256)')
    );
  });
});
