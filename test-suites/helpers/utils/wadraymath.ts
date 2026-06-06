import {
  BigNumber as ProjectBigNumber,
  BigNumberish as ProjectBigNumberish,
} from '@ethersproject/bignumber';
import { BigNumber as EthersBigNumber, BigNumberish as EthersBigNumberish } from 'ethers';

import {
  RAY,
  WAD,
  HALF_RAY,
  HALF_WAD,
  WAD_RAY_RATIO,
  HALF_PERCENTAGE,
  PERCENTAGE_FACTOR,
} from '../../../helpers/constants';

type AnyBigNumberish = ProjectBigNumberish | EthersBigNumberish;

declare module '@ethersproject/bignumber' {
  interface BigNumber {
    ray: () => ProjectBigNumber;
    wad: () => ProjectBigNumber;
    halfRay: () => ProjectBigNumber;
    halfWad: () => ProjectBigNumber;
    halfPercentage: () => ProjectBigNumber;
    percentageFactor: () => ProjectBigNumber;
    wadMul: (a: AnyBigNumberish) => ProjectBigNumber;
    wadDiv: (a: AnyBigNumberish) => ProjectBigNumber;
    rayMul: (a: AnyBigNumberish) => ProjectBigNumber;
    rayDiv: (a: AnyBigNumberish) => ProjectBigNumber;
    percentMul: (a: AnyBigNumberish) => ProjectBigNumber;
    percentDiv: (a: AnyBigNumberish) => ProjectBigNumber;
    rayToWad: () => ProjectBigNumber;
    wadToRay: () => ProjectBigNumber;
    negated: () => ProjectBigNumber;
  }
}

declare module 'ethers' {
  interface BigNumber {
    ray: () => EthersBigNumber;
    wad: () => EthersBigNumber;
    halfRay: () => EthersBigNumber;
    halfWad: () => EthersBigNumber;
    halfPercentage: () => EthersBigNumber;
    percentageFactor: () => EthersBigNumber;
    wadMul: (a: AnyBigNumberish) => EthersBigNumber;
    wadDiv: (a: AnyBigNumberish) => EthersBigNumber;
    rayMul: (a: AnyBigNumberish) => EthersBigNumber;
    rayDiv: (a: AnyBigNumberish) => EthersBigNumber;
    percentMul: (a: AnyBigNumberish) => EthersBigNumber;
    percentDiv: (a: AnyBigNumberish) => EthersBigNumber;
    rayToWad: () => EthersBigNumber;
    wadToRay: () => EthersBigNumber;
    negated: () => EthersBigNumber;
  }
}

const installWadRayMath = (BigNumberCtor: typeof ProjectBigNumber | typeof EthersBigNumber) => {
  const proto = BigNumberCtor.prototype as any;

  proto.ray = () => BigNumberCtor.from(RAY);
  proto.wad = () => BigNumberCtor.from(WAD);
  proto.halfRay = () => BigNumberCtor.from(HALF_RAY);
  proto.halfWad = () => BigNumberCtor.from(HALF_WAD);
  proto.halfPercentage = () => BigNumberCtor.from(HALF_PERCENTAGE);
  proto.percentageFactor = () => BigNumberCtor.from(PERCENTAGE_FACTOR);

  proto.wadMul = function (other: AnyBigNumberish) {
    return this.halfWad().add(this.mul(other)).div(this.wad());
  };

  proto.wadDiv = function (other: AnyBigNumberish) {
    const halfOther = BigNumberCtor.from(other as any).div(2);
    return halfOther.add(this.mul(this.wad())).div(other);
  };

  proto.rayMul = function (other: AnyBigNumberish) {
    return this.halfRay().add(this.mul(other)).div(this.ray());
  };

  proto.rayDiv = function (other: AnyBigNumberish) {
    const halfOther = BigNumberCtor.from(other as any).div(2);
    return halfOther.add(this.mul(this.ray())).div(other);
  };

  proto.percentMul = function (bps: AnyBigNumberish) {
    return this.halfPercentage().add(this.mul(bps)).div(PERCENTAGE_FACTOR);
  };

  proto.percentDiv = function (bps: AnyBigNumberish) {
    const halfBps = BigNumberCtor.from(bps as any).div(2);
    return halfBps.add(this.mul(PERCENTAGE_FACTOR)).div(bps);
  };

  proto.rayToWad = function () {
    const halfRatio = BigNumberCtor.from(WAD_RAY_RATIO).div(2);
    return halfRatio.add(this).div(WAD_RAY_RATIO);
  };

  proto.wadToRay = function () {
    return this.mul(WAD_RAY_RATIO);
  };

  proto.negated = function () {
    return this.mul(-1);
  };
};

installWadRayMath(ProjectBigNumber);
installWadRayMath(EthersBigNumber);
