import {mainnetConfig} from "@chainsafe/lodestar-config/mainnet";
import {minimalConfig} from "@chainsafe/lodestar-config/minimal";
import {expect} from "chai";
import {assertEqualParams, NotEqualParamsError} from "../../../src/util/params";

describe("utils / params / assertEqualParams", () => {
  it("mainnet == mainnet", () => {
    assertEqualParams(mainnetConfig.params, mainnetConfig.params);
  });

  it("minimal == minimal", () => {
    assertEqualParams(minimalConfig.params, minimalConfig.params);
  });

  it("mainnet != minimal", () => {
    expect(() => assertEqualParams(mainnetConfig.params, minimalConfig.params)).to.throw(NotEqualParamsError);
  });

  it("minimal != mainnet", () => {
    expect(() => assertEqualParams(minimalConfig.params, mainnetConfig.params)).to.throw(NotEqualParamsError);
  });
});
