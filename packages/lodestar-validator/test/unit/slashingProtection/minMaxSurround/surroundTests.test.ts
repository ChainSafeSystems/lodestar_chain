import chai, {expect} from "chai";
import chaiAsPromised from "chai-as-promised";
import {DistanceStoreMemory, emptyPubkey} from "./utils";
import {MinMaxSurround, SurroundAttestationError} from "../../../../src/slashingProtection/minMaxSurround";

chai.use(chaiAsPromised);

// Test values from prysmaticlabs/prysm
// https://github.com/prysmaticlabs/prysm/blob/9e712e4598dce20b7b0786d46f64371bbd8cd3ca/slasher/detection/attestations/spanner_test.go#L270
const surroundTests: {
  name: string;
  sourceEpoch: number;
  targetEpoch: number;
  slashableEpoch?: number;
  shouldSlash: boolean;
  spansByEpoch: {[source: number]: [number, number]};
}[] = [
  {
    name: "Should slash if max span > distance",
    sourceEpoch: 3,
    targetEpoch: 6,
    slashableEpoch: 7,
    shouldSlash: true,
    // Given a distance of (6 - 3) = 3, we want the validator at epoch 3 to have
    // committed a slashable offense by having a max span of 4 > distance.
    spansByEpoch: {
      // [minSpan, maxSpan]
      3: [0, 4],
    },
  },
  {
    name: "Should NOT slash if max span < distance",
    sourceEpoch: 3,
    targetEpoch: 6,
    // Given a distance of (6 - 3) = 3, we want the validator at epoch 3 to NOT
    // have committed slashable offense by having a max span of 1 < distance.
    shouldSlash: false,
    spansByEpoch: {
      3: [0, 1],
    },
  },
  {
    name: "Should NOT slash if max span == distance",
    sourceEpoch: 3,
    targetEpoch: 6,
    // Given a distance of (6 - 3) = 3, we want the validator at epoch 3 to NOT
    // have committed slashable offense by having a max span of 3 == distance.
    shouldSlash: false,
    spansByEpoch: {
      3: [0, 3],
    },
  },
  {
    name: "Should NOT slash if min span == 0",
    sourceEpoch: 3,
    targetEpoch: 6,
    // Given a min span of 0 and no max span slashing, we want validator to NOT
    // have committed a slashable offense if min span == 0.
    shouldSlash: false,
    spansByEpoch: {
      3: [0, 1],
    },
  },
  {
    name: "Should slash if min span > 0 and min span < distance",
    sourceEpoch: 3,
    targetEpoch: 6,
    // Given a distance of (6 - 3) = 3, we want the validator at epoch 3 to have
    // committed a slashable offense by having a min span of 1 < distance.
    shouldSlash: true,
    slashableEpoch: 4,
    spansByEpoch: {
      3: [1, 0],
    },
  },
  // Proto Max Span Tests from the eth2-surround repo.
  {
    name: "Proto max span test #1",
    sourceEpoch: 8,
    targetEpoch: 18,
    shouldSlash: false,
    spansByEpoch: {
      0: [4, 0],
      1: [2, 0],
      2: [1, 0],
      4: [0, 2],
      5: [0, 1],
    },
  },
  {
    name: "Proto max span test #2",
    sourceEpoch: 4,
    targetEpoch: 12,
    shouldSlash: false,
    slashableEpoch: 0,
    spansByEpoch: {
      4: [14, 2],
      5: [13, 1],
      6: [12, 0],
      7: [11, 0],
      9: [0, 9],
      10: [0, 8],
      11: [0, 7],
      12: [0, 6],
      13: [0, 5],
      14: [0, 4],
      15: [0, 3],
      16: [0, 2],
      17: [0, 1],
    },
  },
  {
    name: "Proto max span test #3",
    sourceEpoch: 10,
    targetEpoch: 15,
    shouldSlash: true,
    slashableEpoch: 18,
    spansByEpoch: {
      4: [14, 2],
      5: [13, 7],
      6: [12, 6],
      7: [11, 5],
      8: [0, 4],
      9: [0, 9],
      10: [0, 8],
      11: [0, 7],
      12: [0, 6],
      13: [0, 5],
      14: [0, 4],
      15: [0, 3],
      16: [0, 2],
      17: [0, 1],
    },
  },
  // Proto Min Span Tests from the eth2-surround repo.
  {
    name: "Proto min span test #1",
    sourceEpoch: 4,
    targetEpoch: 6,
    shouldSlash: false,
    spansByEpoch: {
      1: [5, 0],
      2: [4, 0],
      3: [3, 0],
    },
  },
  {
    name: "Proto min span test #2",
    sourceEpoch: 11,
    targetEpoch: 15,
    shouldSlash: false,
    spansByEpoch: {
      1: [5, 0],
      2: [4, 0],
      3: [3, 0],
      4: [14, 0],
      5: [13, 1],
      6: [12, 0],
      7: [11, 0],
      8: [10, 0],
      9: [9, 0],
      10: [8, 0],
      11: [7, 0],
      12: [6, 0],
      14: [0, 4],
      15: [0, 3],
      16: [0, 2],
      17: [0, 1],
    },
  },
  {
    name: "Proto min span test #3",
    sourceEpoch: 9,
    targetEpoch: 19,
    shouldSlash: true,
    slashableEpoch: 14,
    spansByEpoch: {
      0: [5, 0],
      1: [4, 0],
      2: [3, 0],
      3: [11, 0],
      4: [10, 1],
      5: [9, 0],
      6: [8, 0],
      7: [7, 0],
      8: [6, 0],
      9: [5, 0],
      10: [7, 0],
      11: [6, 3],
      12: [0, 2],
      13: [0, 1],
      14: [0, 3],
      15: [0, 2],
      16: [0, 1],
      17: [0, 0],
    },
  },
];

describe("surroundTests", () => {
  for (const {name, shouldSlash, slashableEpoch, sourceEpoch, targetEpoch, spansByEpoch} of surroundTests) {
    it(name, async () => {
      const store = new DistanceStoreMemory();
      for (const [epoch, [minSpan, maxSpan]] of Object.entries(spansByEpoch)) {
        store.minSpan.map.set(parseInt(epoch), minSpan);
        store.maxSpan.map.set(parseInt(epoch), maxSpan);
      }

      const minMaxSurround = new MinMaxSurround(store);

      if (shouldSlash) {
        try {
          await minMaxSurround.assertNoSurround(emptyPubkey, {source: sourceEpoch, target: targetEpoch});
          throw Error("Should slash");
        } catch (e: unknown) {
          if (e instanceof SurroundAttestationError) {
            if (slashableEpoch) {
              expect(e.type.att2Target).to.equal(slashableEpoch, "Wrong slashableEpoch");
            }
          } else {
            throw Error(`Wrong error type: ${e.stack}`);
          }
        }
      } else {
        await minMaxSurround.assertNoSurround(emptyPubkey, {source: sourceEpoch, target: targetEpoch});
      }
    });
  }
});
