import {join} from "path";
import {expect} from "chai";

import {describeDirectorySpecTest, InputType} from "@chainsafe/lodestar-spec-test-util";
import {altair, CachedBeaconState, allForks} from "@chainsafe/lodestar-beacon-state-transition";
import {altair as altairTypes, ssz} from "@chainsafe/lodestar-types";
import {SPEC_TEST_LOCATION} from "../../../../utils/specTestCases";
import {IAltairStateTestCase} from "../../stateTestCase";
import {TreeBacked} from "@chainsafe/ssz";
import {createIBeaconConfig} from "@chainsafe/lodestar-config";

// eslint-disable-next-line @typescript-eslint/naming-convention
const config = createIBeaconConfig({ALTAIR_FORK_EPOCH: 0});

describeDirectorySpecTest<IAltairStateTestCase, altairTypes.BeaconState>(
  "altair epoch registry updates minimal",
  join(SPEC_TEST_LOCATION, "tests/minimal/altair/epoch_processing/registry_updates/pyspec_tests"),
  (testcase) => {
    const wrappedState = allForks.createCachedBeaconState<altair.BeaconState>(
      config,
      (testcase.pre as TreeBacked<altair.BeaconState>).clone()
    );
    const process = allForks.prepareEpochProcessState(wrappedState);
    allForks.processRegistryUpdates(wrappedState as CachedBeaconState<allForks.BeaconState>, process);
    return wrappedState;
  },
  {
    inputTypes: {
      pre: {
        type: InputType.SSZ_SNAPPY,
        treeBacked: true,
      },
      post: {
        type: InputType.SSZ_SNAPPY,
        treeBacked: true,
      },
    },
    sszTypes: {
      pre: ssz.altair.BeaconState,
      post: ssz.altair.BeaconState,
    },
    getExpected: (testCase) => testCase.post,
    expectFunc: (testCase, expected, actual) => {
      expect(ssz.altair.BeaconState.equals(actual, expected)).to.be.true;
    },
  }
);
