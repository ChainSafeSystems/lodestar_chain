import path from "path";
import bls from "@chainsafe/bls";
import {describeDirectorySpecTest, InputType} from "@chainsafe/lodestar-spec-test-util/lib";

import {SPEC_TEST_LOCATION} from "../../utils/specTestCases";

interface IAggregateSigsTestCase {
  data: {
    input: string[];
    output: string;
  };
}

describeDirectorySpecTest<IAggregateSigsTestCase, string | null>(
  "BLS - aggregate sigs",
  path.join(SPEC_TEST_LOCATION, "tests/general/phase0/bls/aggregate/small"),
  (testCase) => {
    try {
      const result = bls.aggregateSignatures(
        testCase.data.input.map((pubKey) => {
          return Buffer.from(pubKey.replace("0x", ""), "hex");
        })
      );
      return `0x${Buffer.from(result).toString("hex")}`;
    } catch (e: unknown) {
      if (e.message === "signatures is null or undefined or empty array") {
        return null;
      }
      throw e;
    }
  },
  {
    inputTypes: {
      data: InputType.YAML,
    },
    getExpected: (testCase) => testCase.data.output,
    shouldError: (testCase) => testCase.data.output == null,
  }
);
