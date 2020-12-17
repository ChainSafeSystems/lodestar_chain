import {IReadonlyEpochShuffling} from ".";
import {ValidatorIndex, Slot} from "@chainsafe/lodestar-types";
import {ByteVector} from "@chainsafe/ssz";

/**
 * Readonly interface for EpochContext.
 */
export type ReadonlyEpochContext = {
  readonly pubkey2index: ReadonlyMap<ByteVector, ValidatorIndex>;
  readonly index2pubkey: Readonly<Uint8Array[]>;
  readonly currentShuffling?: IReadonlyEpochShuffling;
  readonly previousShuffling?: IReadonlyEpochShuffling;
  getBeaconProposer: (slot: Slot) => ValidatorIndex;
};